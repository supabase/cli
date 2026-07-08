import { Console, Effect, FileSystem, Path, Redacted, Schema } from "effect";
import * as SmolToml from "smol-toml";
import { ProjectConfigSchema, RemotesSchema, type ProjectConfig } from "./base.ts";
import {
  DuplicateRemoteProjectIdError,
  InvalidRemoteProjectIdError,
  ProjectConfigParseError,
} from "./errors.ts";
import { interpolateEnvReferencesAgainstSchema } from "./lib/env.ts";
import { findProjectPaths } from "./paths.ts";
import { loadProjectEnvironment, type ProjectEnvironment } from "./project.ts";

const projectConfigSchemaKey = "$schema";

export type ConfigFormat = "json" | "toml";

export interface LoadedProjectConfig {
  readonly path: string;
  readonly format: ConfigFormat;
  readonly config: ProjectConfig;
  readonly schemaRef?: string;
  readonly ignoredPaths: ReadonlyArray<string>;
  /**
   * The raw, post-`env()`-interpolation document the `config` was decoded from,
   * with any matching `[remotes.*]` override already merged in (see
   * {@link LoadProjectConfigOptions.projectRef}). Lets callers inspect key
   * presence — which the decoded `config` loses because the schema defaults
   * optional sections — without re-reading the file. Present whenever the file
   * parsed to an object.
   */
  readonly document?: Record<string, unknown>;
  /**
   * Name of the `[remotes.<name>]` block whose subtree was merged over the base
   * config because its `project_id` matched the requested `projectRef`.
   * `undefined` when no `projectRef` was requested or none matched.
   */
  readonly appliedRemote?: string;
}

/**
 * When `projectRef` is set, the matching `[remotes.<name>]` block (the one
 * whose `project_id` equals it) is merged over the base config before decode,
 * mirroring Go's `config.Load` with `Config.ProjectId` set
 * (`apps/cli-go/pkg/config/config.go:503-562`). Omitting it loads the base
 * config verbatim (no merge), so existing callers are unaffected. Go's
 * duplicate-`project_id`/project-ref-format checks across every
 * `[remotes.*]` block (`config.go:594-602,996-1001`) run unconditionally on
 * every config load in Go, not only when a caller ends up selecting a
 * remote — but here they only run when {@link LoadProjectConfigOptions.goViperCompat}
 * is `true`, regardless of whether `projectRef` is set, so non-Go-parity
 * callers that never select a remote (and never opt into Go parity) aren't
 * broken by an unrelated duplicate/malformed `[remotes.*]` block.
 */
export interface LoadProjectConfigOptions {
  readonly projectRef?: string;
  /**
   * Pre-resolved project environment used to interpolate `env()` references.
   * When omitted, the environment is resolved internally from `.env`/`.env.local`
   * layered over `process.env` (the default for most callers). Callers that need
   * Go-accurate, environment-specific resolution (e.g. `functions serve`, which
   * also reads `.env.<SUPABASE_ENV>` files) resolve it themselves and pass it in
   * so loading does not re-read those files or depend on `process.env` mutation.
   */
  readonly projectEnv?: ProjectEnvironment;
  /** See {@link FindProjectPathsOptions.search}. */
  readonly search?: boolean;
  /**
   * Skip the `config.json`-over-`config.toml` preference below and only ever
   * load `config.toml`. Go's `Config.Load`/`NewPathBuilder`
   * (`apps/cli-go/pkg/config/utils.go:43-48`) has no concept of a JSON project
   * config file — it always resolves `supabase/config.toml` and treats a
   * missing file as defaults — so Go-parity callers (the legacy `status`/`stop`
   * ports) must set this to avoid picking up a stray `config.json` that Go
   * would never see.
   */
  readonly tomlOnly?: boolean;
  /**
   * Opt into the Go/viper-parity decode+validation semantics this loader
   * otherwise omits, so only the Go-parity legacy shell (and shared modules
   * invoked exclusively by it) pays for them. Defaults to `false` = pre-PR-#5765
   * behavior, which `next/`, `packages/stack`, and the functions manifest rely
   * on. When `true`, mirrors Go's `config.Load` exactly:
   *  - runs the unconditional duplicate-`project_id` and project-ref-format
   *    checks across every `[remotes.*]` block (`config.go:594-602,996-1001`),
   *    even when no `projectRef` is requested;
   *  - warns on stderr for deprecated `auth.external.{linkedin,slack}` blocks
   *    (`config.go:1418-1423`) — the block is stripped from the decoded config
   *    either way, since the schema ignores excess properties;
   *  - matches `env(...)` references case-agnostically (`^env\((.*)\)$`)
   *    rather than the strict SCREAMING_SNAKE_CASE form;
   *  - splits a comma-separated string into a `[]string`-typed field (Go's
   *    `mapstructure.StringToSliceHookFunc(",")`, `config.go:775-784`), not
   *    just an `env()`-substituted one.
   */
  readonly goViperCompat?: boolean;
}

export interface SaveProjectConfigOptions {
  readonly cwd: string;
  readonly config: ProjectConfig;
  readonly format?: ConfigFormat;
  readonly schemaRef?: string;
}

const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);
/**
 * Decodes the `remotes` map with `disableChecks: true` — full type/shape
 * decoding, defaults, and transformations (e.g. secret redaction) still run,
 * but the `.check()`-based business-rule refinements embedded in `auth`/`db`/
 * etc. (e.g. "external provider requires a secret when enabled") are skipped.
 * See {@link RemotesSchema}'s doc comment for why: Go only ever applies those
 * business rules to the merged effective config, never to a `[remotes.*]`
 * block that wasn't selected.
 */
const decodeRemotesWithoutChecks = Schema.decodeUnknownSync(RemotesSchema, {
  disableChecks: true,
});
const encodeProjectConfig = Schema.encodeSync(ProjectConfigSchema);
const defaultEncodedProjectConfig = encodeProjectConfig(decodeProjectConfig({}));
const defaultEncodedFunctionConfig = {
  enabled: true,
  verify_jwt: true,
  import_map: "",
  entrypoint: "",
  static_files: [],
  env: {},
};

function configJsonPathWith(path: Path.Path, cwd: string): string {
  return path.join(cwd, "supabase", "config.json");
}

function configTomlPathWith(path: Path.Path, cwd: string): string {
  return path.join(cwd, "supabase", "config.toml");
}

function siblingConfigPathWith(path: Path.Path, cwd: string, format: ConfigFormat): string {
  return format === "json" ? configTomlPathWith(path, cwd) : configJsonPathWith(path, cwd);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges a `[remotes.*]` subtree over the base document, reproducing Go's
 * `mergeRemoteConfig` (`apps/cli-go/pkg/config/config.go:550`): nested objects
 * merge recursively; arrays and scalars replace wholesale (viper sets each leaf
 * key). Operates on the raw, pre-decode document so only keys the remote block
 * actually declares override the base — the remote section's schema defaults
 * never leak in.
 */
function mergeRemoteSubtree(
  base: Record<string, unknown>,
  remote: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(remote)) {
    const existing = result[key];
    result[key] =
      isObject(existing) && isObject(value) ? mergeRemoteSubtree(existing, value) : value;
  }
  return result;
}

/** Whether a remote subtree explicitly declares `db.seed.enabled`. */
function remoteSetsDbSeedEnabled(remote: Record<string, unknown>): boolean {
  const db = remote["db"];
  const seed = isObject(db) ? db["seed"] : undefined;
  return isObject(seed) && "enabled" in seed;
}

/** Forces `db.seed.enabled = false`, immutably, matching Go's mergeRemoteConfig. */
function withDbSeedDisabled(document: Record<string, unknown>): Record<string, unknown> {
  const db = isObject(document["db"]) ? document["db"] : {};
  const seed = isObject(db["seed"]) ? db["seed"] : {};
  return { ...document, db: { ...db, seed: { ...seed, enabled: false } } };
}

/**
 * Builds a `project_id -> "[remotes.<name>]"` map across every `[remotes.*]`
 * block, failing on the first duplicate. Mirrors Go's `loadFromFile`
 * (`config.go:594-602`): that loop runs unconditionally on every config load,
 * regardless of whether any remote's `project_id` ends up matching
 * `Config.ProjectId`. Here, {@link applyRemoteOverride} only invokes this when
 * `goViperCompat` is set, so it still runs even for callers that don't
 * request a specific `projectRef` — but only under Go-parity mode. A missing
 * `project_id` reads as `""` (Go's `viper.GetString`), so two remotes that
 * both omit it collide on the empty key and fail just as in Go.
 */
const checkDuplicateRemoteProjectIds = Effect.fnUntraced(function* (
  remotes: Record<string, unknown>,
) {
  const idToName = new Map<string, string>();
  for (const [remoteName, remote] of Object.entries(remotes)) {
    const projectId =
      isObject(remote) && typeof remote["project_id"] === "string" ? remote["project_id"] : "";
    const other = idToName.get(projectId);
    if (other !== undefined) {
      return yield* new DuplicateRemoteProjectIdError({
        message: `duplicate project_id for [remotes.${remoteName}] and ${other}`,
      });
    }
    idToName.set(projectId, `[remotes.${remoteName}]`);
  }
});

/** Go's project-ref pattern (`apps/cli-go/pkg/config/config.go:558`): exactly 20
 * lowercase ASCII letters. */
const REMOTE_PROJECT_ID_PATTERN = /^[a-z]{20}$/;

/**
 * Rejects the first `[remotes.*]` block whose `project_id` is not a valid
 * project ref, mirroring Go's `Config.Validate` (`config.go:996-1001`) — that
 * loop runs unconditionally over every remote on every config load, not only
 * the one that ends up selected/merged. Here, {@link applyRemoteOverride} only
 * invokes this when `goViperCompat` is set.
 *
 * Unlike {@link checkDuplicateRemoteProjectIds}/the match below (which read
 * viper's raw, pre-`LoadEnvHook` values — see {@link applyRemoteOverride}'s
 * doc comment), `Config.Validate` runs entirely AFTER the struct decode
 * (`config.go:882`), by which point `LoadEnvHook` has already resolved every
 * `env(...)` reference (`config.go:749-753`). So this check must see the
 * already-interpolated `project_id`, not the literal `env(REF)` form — an
 * `[remotes.x] project_id = "env(REF)"` that resolves to a valid 20-letter ref
 * passes here even though the raw string doesn't match the pattern itself.
 */
const checkRemoteProjectIdFormat = Effect.fnUntraced(function* (remotes: Record<string, unknown>) {
  for (const [remoteName, remote] of Object.entries(remotes)) {
    const projectId =
      isObject(remote) && typeof remote["project_id"] === "string" ? remote["project_id"] : "";
    if (!REMOTE_PROJECT_ID_PATTERN.test(projectId)) {
      return yield* new InvalidRemoteProjectIdError({
        message: `Invalid config for remotes.${remoteName}.project_id. Must be like: abcdefghijklmnopqrst`,
      });
    }
  }
});

/**
 * Applies the `[remotes.<name>]` override whose `project_id` matches `projectRef`
 * to `rawDocument`, mirroring Go's `loadFromFile` remote resolution
 * (`config.go:503-518`). Returns the merged document (with `remotes` stripped,
 * still pre-`env()`-interpolation — the caller re-interpolates the result) and
 * the matched remote name. `projectRef` of `undefined` never matches any remote
 * (including one that itself omits `project_id`, which reads as `""`) — callers
 * that don't request a specific remote get the duplicate/format checks below
 * without the merge, so the base document loads verbatim as before.
 *
 * `rawDocument`'s `remotes` block is the PRE-interpolation document: Go's
 * duplicate-check/selection loop in `loadFromFile` reads directly off viper's
 * raw config values (`v.GetString(fmt.Sprintf("remotes.%s.project_id", name))`,
 * `config.go:596-610`) and only calls `c.load(v)` — which resolves `env(...)`
 * via `LoadEnvHook` during the struct decode (`config.go:749-753`,
 * `decode_hooks.go:13-26`) — afterward (`config.go:611`). So a
 * `[remotes.prod] project_id = "env(REF)"` is matched/deduped against the
 * LITERAL `env(REF)` string in Go, never against `REF`'s resolved value; this
 * mirrors that exactly rather than matching post-interpolation, which would
 * merge a remote Go itself would never select. `interpolatedRemotes` (Go's
 * post-decode `c.Remotes`, mirrored here as the already-interpolated
 * `remotes` subtree) is used only for {@link checkRemoteProjectIdFormat} — see
 * its doc comment for why that check needs the resolved value instead.
 */
const applyRemoteOverride = Effect.fnUntraced(function* (
  rawDocument: Record<string, unknown>,
  interpolatedRemotes: Record<string, unknown> | undefined,
  projectRef: string | undefined,
  goViperCompat: boolean,
) {
  const remotes = rawDocument["remotes"];
  if (!isObject(remotes)) {
    return { document: rawDocument, appliedRemote: undefined as string | undefined };
  }
  if (goViperCompat) {
    yield* checkDuplicateRemoteProjectIds(remotes);
    yield* checkRemoteProjectIdFormat(interpolatedRemotes ?? remotes);
  }
  const name = Object.entries(remotes).find(([, remote]) => {
    const projectId =
      isObject(remote) && typeof remote["project_id"] === "string" ? remote["project_id"] : "";
    return projectRef !== undefined && projectId === projectRef;
  })?.[0];
  if (name === undefined) {
    return { document: rawDocument, appliedRemote: undefined as string | undefined };
  }
  const remoteSubtree = remotes[name];
  let merged = isObject(remoteSubtree)
    ? mergeRemoteSubtree(rawDocument, remoteSubtree)
    : { ...rawDocument };
  if (!(isObject(remoteSubtree) && remoteSetsDbSeedEnabled(remoteSubtree))) {
    merged = withDbSeedDisabled(merged);
  }
  delete merged["remotes"];
  return { document: merged, appliedRemote: name };
});

function isEqualValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index += 1) {
      if (!isEqualValue(left[index], right[index])) {
        return false;
      }
    }

    return true;
  }

  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    for (const key of leftKeys) {
      if (!(key in right) || !isEqualValue(left[key], right[key])) {
        return false;
      }
    }

    return true;
  }

  return Object.is(left, right);
}

function stripDefaults(value: unknown, defaults: unknown): unknown {
  if (defaults === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return isEqualValue(value, defaults) ? undefined : value;
  }

  if (isObject(value)) {
    const defaultObject = isObject(defaults) ? defaults : {};
    const result: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(value)) {
      const stripped = stripDefaults(child, defaultObject[key]);

      if (stripped !== undefined) {
        result[key] = stripped;
      }
    }

    return Object.keys(result).length === 0 ? undefined : result;
  }

  return isEqualValue(value, defaults) ? undefined : value;
}

function stripFunctionRecordDefaults(value: unknown): unknown {
  if (!isObject(value)) {
    return value;
  }

  const functionsValue = value.functions;
  if (!isObject(functionsValue)) {
    return value;
  }

  const functions: Record<string, unknown> = {};
  for (const [name, functionConfig] of Object.entries(functionsValue)) {
    functions[name] = stripDefaults(functionConfig, defaultEncodedFunctionConfig) ?? {};
  }

  return { ...value, functions };
}

function encodeMinimalProjectConfig(config: ProjectConfig): Record<string, unknown> {
  const encoded = stripFunctionRecordDefaults(encodeProjectConfig(config));
  const stripped = stripDefaults(encoded, defaultEncodedProjectConfig);
  return isObject(stripped) ? stripped : {};
}

function toConfigDocument(
  config: ProjectConfig,
  schemaRef: string | undefined,
): Record<string, unknown> {
  const encoded = encodeMinimalProjectConfig(config);
  return schemaRef === undefined ? encoded : { [projectConfigSchemaKey]: schemaRef, ...encoded };
}

function parseProjectConfigDocument(content: string, format: ConfigFormat): unknown {
  return format === "json" ? JSON.parse(content) : SmolToml.parse(content);
}

interface NormalizedSMTPDocument {
  readonly document: unknown;
  /** Section paths that used the deprecated `inbucket` key, e.g. `inbucket`, `remotes.staging.inbucket`. */
  readonly deprecatedSections: ReadonlyArray<string>;
}

/**
 * Rewrites the deprecated `[inbucket]` config section (top-level and per
 * `[remotes.*]`) to its preferred `[local_smtp]` name, mirroring Go's
 * `normalizeDeprecatedSMTPConfig`. When both keys are present the explicit
 * `local_smtp` wins and `inbucket` is dropped. The returned `deprecatedSections`
 * drive the user-facing deprecation warnings emitted by the caller.
 */
function normalizeDeprecatedSMTPSections(document: unknown): NormalizedSMTPDocument {
  if (!isObject(document)) {
    return { document, deprecatedSections: [] };
  }
  const deprecatedSections: Array<string> = [];
  const normalized = { ...document };
  if ("inbucket" in normalized) {
    deprecatedSections.push("inbucket");
    if (!("local_smtp" in normalized)) {
      normalized.local_smtp = normalized.inbucket;
    }
    delete normalized.inbucket;
  }
  if (isObject(normalized.remotes)) {
    normalized.remotes = Object.fromEntries(
      Object.entries(normalized.remotes).map(([name, remote]) => {
        if (!isObject(remote) || !("inbucket" in remote)) {
          return [name, remote];
        }
        deprecatedSections.push(`remotes.${name}.inbucket`);
        const normalizedRemote = { ...remote };
        if (!("local_smtp" in normalizedRemote)) {
          normalizedRemote.local_smtp = normalizedRemote.inbucket;
        }
        delete normalizedRemote.inbucket;
        return [name, normalizedRemote];
      }),
    );
  }
  return { document: normalized, deprecatedSections };
}

interface NormalizedExternalProvidersDocument {
  readonly document: unknown;
  /** Provider ids (`"linkedin"` | `"slack"`) whose deprecated top-level block was `enabled` — drives the WARN. */
  readonly deprecatedProviders: ReadonlyArray<string>;
}

const DEPRECATED_EXTERNAL_PROVIDERS = ["linkedin", "slack"] as const;

/**
 * Go's `(e external) validate()` deprecated-provider handling
 * (`apps/cli-go/pkg/config/config.go:1418-1423`): `linkedin`/`slack` are
 * unconditionally deleted from `auth.external` before the required-field loop
 * runs, so a bare `[auth.external.slack] enabled = true` with no
 * `client_id`/`secret` loads fine in Go — a warning prints to stderr only
 * when the deleted provider was `enabled`, never a hard failure.
 *
 * Unlike {@link normalizeDeprecatedSMTPSections}'s `[inbucket]` rename — which
 * Go's own `normalizeDeprecatedSMTPConfig` runs BEFORE remote selection, over
 * every `[remotes.*]` entry unconditionally (`config.go:594,614-640`) — Go's
 * `external.validate()` runs from `Config.Validate()`, exactly ONCE on the
 * final post-remote-merge struct (`config.go:882,1148`). A non-selected
 * remote's own `auth.external.slack` block is never even looked at by Go. So
 * this must run on the POST-merge document (`documentForDecode`, after
 * `applyRemoteOverride`), not the pre-merge one:
 *  - the top-level `auth.external.{linkedin,slack}` is always stripped, and
 *    reported (for the caller to warn on) only when it was `enabled`,
 *    matching Go's single `external.validate()` call.
 *  - any `remotes.*.auth.external.{linkedin,slack}` still present (only
 *    possible when no remote matched `projectRef`, so `applyRemoteOverride`
 *    left `remotes` in place) is also stripped, but never reported — purely
 *    so `remoteProjectConfig`'s eager, whole-map schema decode
 *    (`packages/config/src/base.ts`) doesn't reject an unselected remote's
 *    deprecated block over a field Go itself never struct-decodes at all for
 *    a remote that isn't in effect.
 */
function normalizeDeprecatedExternalProviders(
  document: unknown,
): NormalizedExternalProvidersDocument {
  if (!isObject(document)) {
    return { document, deprecatedProviders: [] };
  }
  const normalized = { ...document };
  const deprecatedProviders: Array<string> = [];
  if (isObject(normalized.auth) && isObject(normalized.auth.external)) {
    const external = { ...normalized.auth.external };
    for (const ext of DEPRECATED_EXTERNAL_PROVIDERS) {
      const provider = external[ext];
      if (provider === undefined) continue;
      if (isObject(provider) && provider.enabled === true) {
        deprecatedProviders.push(ext);
      }
      delete external[ext];
    }
    normalized.auth = { ...normalized.auth, external };
  }
  if (isObject(normalized.remotes)) {
    normalized.remotes = Object.fromEntries(
      Object.entries(normalized.remotes).map(([name, remote]) => {
        if (!isObject(remote) || !isObject(remote.auth) || !isObject(remote.auth.external)) {
          return [name, remote];
        }
        const external = { ...remote.auth.external };
        for (const ext of DEPRECATED_EXTERNAL_PROVIDERS) {
          delete external[ext];
        }
        return [name, { ...remote, auth: { ...remote.auth, external } }];
      }),
    );
  }
  return { document: normalized, deprecatedProviders };
}

/**
 * Wraps every `edge_runtime.secrets` value in `Redacted` before it's attached
 * to `ProjectConfigParseError.document`. By this point `secrets` values are
 * real, resolved secrets (post `env()` interpolation, see
 * `interpolateEnvReferencesAgainstSchema` in `loadProjectConfigFile`) — the
 * same values `secret()` (`lib/env.ts`) annotates `x-secret` for elsewhere in
 * this package (`resolveProjectValue`'s `redactValue`). Several callers of
 * `loadProjectConfig` (`gen types`, `next start`, `functions dev/serve/deploy`)
 * don't catch `ProjectConfigParseError` at all, so this keeps the same
 * accidental-leak protection `Redacted` already gives every other secret path
 * in this package, in case an uncaught error's `document` ever reaches a log
 * or trace. `secrets set`'s `recoverEdgeRuntimeConfig`/`filterDecodableSecrets`
 * unwrap via `Redacted.isRedacted`/`Redacted.value` before re-decoding.
 */
function redactEdgeRuntimeSecrets(edgeRuntime: unknown): unknown {
  if (!isObject(edgeRuntime) || !("secrets" in edgeRuntime)) {
    return edgeRuntime;
  }
  if (!isObject(edgeRuntime.secrets)) {
    // The whole `secrets` field is malformed — e.g. `secrets = ["actual-secret"]`
    // (a TOML array instead of a table) — rather than a single bad entry
    // inside an otherwise-valid table. Still carries a secret in its
    // structure, so wrap the field as one unit with the same rationale as
    // the per-entry case below. Guarded by `"secrets" in edgeRuntime`
    // (not just falling through on `undefined`) so `edge_runtime` documents
    // that legitimately omit `secrets` don't gain a spurious
    // `Redacted.make(undefined)` field.
    return {
      ...edgeRuntime,
      secrets: Redacted.make(edgeRuntime.secrets, { label: "edge_runtime.secrets" }),
    };
  }
  return {
    ...edgeRuntime,
    // Wrap the whole entry, not just string values: a malformed
    // `[edge_runtime.secrets]` entry (e.g. a TOML array `FOO = ["actual-secret"]`
    // or inline table) still carries the secret in its structure, and
    // `Redacted.make` accepts any value — `toString`/`toJSON` always render
    // `<redacted:...>` regardless of the wrapped type, so this can't leak a
    // non-string entry either.
    secrets: Object.fromEntries(
      Object.entries(edgeRuntime.secrets).map(([name, value]) => [
        name,
        Redacted.make(value, { label: `edge_runtime.secrets.${name}` }),
      ]),
    ),
  };
}

function getSchemaRef(document: unknown): string | undefined {
  if (!isObject(document)) {
    return undefined;
  }

  const schemaRef = document[projectConfigSchemaKey];
  return typeof schemaRef === "string" ? schemaRef : undefined;
}

function parseProjectConfig(
  document: unknown,
  format: ConfigFormat,
  path: string,
  appliedRemote: string | undefined,
): Effect.Effect<ProjectConfig, ProjectConfigParseError> {
  return Effect.try({
    try: () => {
      // Decode `remotes` separately, with business-rule checks disabled — see
      // `decodeRemotesWithoutChecks`/`RemotesSchema`'s doc comments. Non-selected
      // `[remotes.*]` blocks reach here still attached to `document` (only a
      // SELECTED remote gets merged in and stripped from `remotes` by
      // `applyRemoteOverride`), so decoding them through the normal,
      // checks-enabled `decodeProjectConfig` below would apply Go's
      // merged-config-only business rules to every remote regardless of
      // selection. Structural decoding (types, defaults, transformations)
      // still runs either way, matching Go's unconditional `UnmarshalExact`
      // struct decode of every remote.
      const rawRemotes = isObject(document) ? document.remotes : undefined;
      const config = decodeProjectConfig(
        isObject(document) ? { ...document, remotes: {} } : document,
      );
      return { ...config, remotes: decodeRemotesWithoutChecks(rawRemotes ?? {}) };
    },
    // `document` always parsed successfully by this point (raw parse failures
    // are caught earlier, in `loadProjectConfigFile`), so any error here is a
    // schema-decode failure — attach it so callers can attempt a narrower,
    // Go-tolerant re-decode of an unaffected subtree. See the field doc on
    // `ProjectConfigParseError.document`. Only the `edge_runtime` subtree is
    // retained (not the whole document): it's the only slice any caller
    // re-decodes today (`secrets set`'s `recoverEdgeRuntimeConfig`), and several
    // callers of `loadProjectConfig` (e.g. `gen types`, `next start`,
    // `functions dev/serve/deploy`) don't catch `ProjectConfigParseError` at
    // all, so this error can propagate with whatever we attach here — no
    // reason to carry unrelated sections (db credentials, other
    // `[remotes.*]` blocks, etc.) along for the ride. `appliedRemote` is passed
    // through unconditionally too — see the field doc on
    // `ProjectConfigParseError.appliedRemote` for why a tolerant caller still
    // owes the override notice on this path.
    catch: (cause) =>
      new ProjectConfigParseError({
        path,
        format,
        cause,
        document: isObject(document)
          ? { edge_runtime: redactEdgeRuntimeSecrets(document.edge_runtime) }
          : undefined,
        appliedRemote,
      }),
  });
}

export const configJsonPath = Effect.fnUntraced(function* (cwd: string) {
  const path = yield* Path.Path;
  const project = yield* findProjectPaths(cwd);
  return configJsonPathWith(path, project?.projectRoot ?? cwd);
});

export const configTomlPath = Effect.fnUntraced(function* (cwd: string) {
  const path = yield* Path.Path;
  const project = yield* findProjectPaths(cwd);
  return configTomlPathWith(path, project?.projectRoot ?? cwd);
});

export function encodeProjectConfigToJson(config: ProjectConfig): string {
  return encodeProjectConfigToJsonDocument(config, undefined);
}

export function encodeProjectConfigToToml(config: ProjectConfig): string {
  return encodeProjectConfigToTomlDocument(config, undefined);
}

function encodeProjectConfigToJsonDocument(
  config: ProjectConfig,
  schemaRef: string | undefined,
): string {
  return `${JSON.stringify(toConfigDocument(config, schemaRef), null, 2)}\n`;
}

function encodeProjectConfigToTomlDocument(
  config: ProjectConfig,
  schemaRef: string | undefined,
): string {
  return `${SmolToml.stringify(toConfigDocument(config, schemaRef))}\n`;
}

export const loadProjectConfigFile = Effect.fnUntraced(function* (
  filePath: string,
  options?: LoadProjectConfigOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const format = filePath.endsWith(".json") ? "json" : "toml";
  const content = yield* fs.readFileString(filePath);
  const document = yield* Effect.try({
    try: () => parseProjectConfigDocument(content, format),
    catch: (cause) => new ProjectConfigParseError({ path: filePath, format, cause }),
  });
  const { document: normalized, deprecatedSections } = normalizeDeprecatedSMTPSections(document);
  // Warn on stderr (matching Go's normalizeDeprecatedSMTPConfig) so the notice
  // never pollutes machine-readable stdout payloads.
  for (const section of deprecatedSections) {
    const replacement = section.replace(/inbucket$/, "local_smtp");
    yield* Console.error(
      `WARN: config section [${section}] is deprecated. Please use [${replacement}] instead.`,
    );
  }

  // Substitute `env(VAR)` references against `.env`/`.env.local`/ambient env
  // before schema decode. Required for numeric/boolean fields, which would
  // otherwise crash the strict decoder with `Expected number` (CLI-1489).
  // The config file lives at `<projectRoot>/supabase/config.{toml,json}`, so
  // walking two directories up gives us the project root that
  // `loadProjectEnvironment` expects.
  const projectRoot = path.dirname(path.dirname(filePath));
  const projectEnv =
    options?.projectEnv ??
    (yield* loadProjectEnvironment({
      cwd: projectRoot,
      baseEnv: process.env,
      search: options?.search,
    }));
  const goViperCompat = options?.goViperCompat ?? false;
  const interpolateDocument = (document: unknown): unknown =>
    interpolateEnvReferencesAgainstSchema(document, projectEnv?.values ?? {}, ProjectConfigSchema, {
      goViperCompat,
    });

  // Interpolated once here purely to give `applyRemoteOverride`'s FORMAT check
  // (not its match/merge — see that function's doc comment) the resolved
  // `remotes.*.project_id`, matching Go's post-decode `Config.Validate`.
  const interpolatedForValidation = interpolateDocument(normalized);
  const interpolatedRemotes =
    isObject(interpolatedForValidation) && isObject(interpolatedForValidation["remotes"])
      ? interpolatedForValidation["remotes"]
      : undefined;

  // Merge the matching `[remotes.*]` override over the RAW (pre-`env()`-
  // interpolation) document — Go's `loadFromFile` duplicate-check/selection
  // loop runs on viper's raw string values, before `LoadEnvHook` ever resolves
  // `env(...)` (`config.go:594-611`, `decode_hooks.go:13-26`); see
  // `applyRemoteOverride`'s doc comment. The match/merge itself always runs
  // (callers that don't request a `projectRef` just never match a remote, so
  // the base document loads verbatim), but the duplicate-`project_id`/format
  // checks only run when `goViperCompat` is set — see `applyRemoteOverride`.
  let documentForDecode: unknown = normalized;
  let appliedRemote: string | undefined;
  if (isObject(normalized)) {
    const resolved = yield* applyRemoteOverride(
      normalized,
      interpolatedRemotes,
      options?.projectRef,
      goViperCompat,
    );
    documentForDecode = resolved.document;
    appliedRemote = resolved.appliedRemote;
  }

  // The merge above ran on the raw document, so any `env(...)` reference in
  // the winning remote's subtree (or elsewhere in the base) still needs
  // resolving before decode — mirrors Go's `LoadEnvHook` running on the
  // post-merge viper store inside `c.load(v)`. When no remote matched, this
  // recomputes the same substitutions `interpolatedForValidation` already
  // made (documentForDecode is just `normalized` again) — a redundant walk on
  // that path, but correctness on the match+`env()` path matters more than
  // avoiding it.
  documentForDecode = isObject(documentForDecode)
    ? interpolateDocument(documentForDecode)
    : documentForDecode;

  // Strip Go's deprecated `auth.external.{linkedin,slack}` provider ids from
  // the POST-remote-merge document, matching `external.validate()` running
  // once on the final effective config (see `normalizeDeprecatedExternalProviders`).
  const { document: normalizedForDecode, deprecatedProviders } =
    normalizeDeprecatedExternalProviders(documentForDecode);
  // Warn on stderr, matching Go's `external.validate()` (`config.go:1418-1423`).
  // Go's own format string is a raw string literal ending in a literal
  // backslash-n (raw string literals never process escapes, and `Fprintf`
  // doesn't append a newline the way `Fprintln` does), so Go's actual stderr
  // bytes have no real line break after this message — a library-internal
  // artifact, not the parity-relevant part, same call already made for
  // `LegacyInvalidPortEnvOverrideError` in the legacy shell. Not reproduced
  // byte-for-byte; `Console.error` supplies a normal trailing newline instead.
  if (goViperCompat) {
    for (const ext of deprecatedProviders) {
      yield* Console.error(
        `WARN: disabling deprecated "${ext}" provider. Please use [auth.external.${ext}_oidc] instead`,
      );
    }
  }

  const config = yield* parseProjectConfig(normalizedForDecode, format, filePath, appliedRemote);

  return {
    path: filePath,
    format,
    config,
    schemaRef: getSchemaRef(document),
    ignoredPaths: [],
    document: isObject(normalizedForDecode) ? normalizedForDecode : undefined,
    appliedRemote,
  } satisfies LoadedProjectConfig;
});

export const loadProjectConfig = Effect.fnUntraced(function* (
  cwd: string,
  options?: LoadProjectConfigOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const project = yield* findProjectPaths(cwd, { search: options?.search });

  if (project === null) {
    return null;
  }

  const jsonPath = project.configPath.endsWith(".json")
    ? project.configPath
    : project.configPath.replace(/config\.toml$/, "config.json");
  const tomlPath = project.configPath.endsWith(".toml")
    ? project.configPath
    : project.configPath.replace(/config\.json$/, "config.toml");

  if (!options?.tomlOnly && (yield* fs.exists(jsonPath))) {
    const json = yield* loadProjectConfigFile(jsonPath, options);

    return {
      ...json,
      ignoredPaths: (yield* fs.exists(tomlPath)) ? [tomlPath] : [],
    } satisfies LoadedProjectConfig;
  }

  if (yield* fs.exists(tomlPath)) {
    return yield* loadProjectConfigFile(tomlPath, options);
  }

  return null;
});

const resolveSaveFormat = Effect.fnUntraced(function* (
  cwd: string,
  format: ConfigFormat | undefined,
) {
  if (format !== undefined) {
    return format;
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const jsonPath = configJsonPathWith(path, cwd);
  const tomlPath = configTomlPathWith(path, cwd);

  if (yield* fs.exists(jsonPath)) {
    return "json" as const;
  }

  if (yield* fs.exists(tomlPath)) {
    return "toml" as const;
  }

  return "json" as const;
});

function writeFileAtomic(
  filePath: string,
  content: string,
): Effect.Effect<void, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    yield* fs.writeFileString(tmpPath, content);
    yield* fs.rename(tmpPath, filePath);
  }).pipe(Effect.catchTag("PlatformError", (e) => Effect.die(e)));
}

export const saveProjectConfig = Effect.fnUntraced(function* (options: SaveProjectConfigOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const project = yield* findProjectPaths(options.cwd);
  const baseCwd = project?.projectRoot ?? options.cwd;
  const format = yield* resolveSaveFormat(baseCwd, options.format);
  const existingConfig =
    options.schemaRef !== undefined || project === null ? null : yield* loadProjectConfig(baseCwd);
  const schemaRef = options.schemaRef ?? existingConfig?.schemaRef;
  const filePath =
    format === "json" ? configJsonPathWith(path, baseCwd) : configTomlPathWith(path, baseCwd);
  const siblingPath = siblingConfigPathWith(path, baseCwd, format);
  const content =
    format === "json"
      ? encodeProjectConfigToJsonDocument(options.config, schemaRef)
      : encodeProjectConfigToTomlDocument(options.config, schemaRef);

  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* writeFileAtomic(filePath, content);
  if (yield* fs.exists(siblingPath)) {
    yield* fs.remove(siblingPath);
  }

  return {
    path: filePath,
    format,
    config: options.config,
    schemaRef,
    ignoredPaths: [],
  } satisfies LoadedProjectConfig;
});
