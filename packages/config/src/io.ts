import { randomBytes } from "node:crypto";
import { Console, Effect, FileSystem, Path, Predicate, Redacted } from "effect";
import * as SmolToml from "smol-toml";
import { CliConfigSchema, type CliConfig } from "./base.ts";
import {
  encodeCliConfigToJsonDocument,
  encodeCliConfigToTomlDocument,
  isObject,
  type LoadedCliConfig,
  type InternalLoadCliConfigOptions,
  cliConfigSchemaKey,
  type CliConfigValueSource,
  type SaveCliConfigOptions,
} from "./config-document.ts";
import type { ConfigFormat } from "./config-format.ts";
import {
  DuplicateRemoteProjectIdError,
  InvalidRemoteProjectIdError,
  CliConfigParseError,
  CliConfigWriteError,
} from "./errors.ts";
import { interpolateEnvReferencesAgainstSchema } from "./lib/env.ts";
import { findCliProjectPaths } from "./paths.ts";
import { setOwnProperty } from "./sparse.ts";
import { loadCliProjectEnvironment } from "./project.ts";
import { validateCliConfig } from "./validate.ts";

function configJsonPathWith(path: Path.Path, cwd: string): string {
  return path.join(cwd, "supabase", "config.json");
}

function configTomlPathWith(path: Path.Path, cwd: string): string {
  return path.join(cwd, "supabase", "config.toml");
}

function siblingConfigPathWith(path: Path.Path, cwd: string, format: ConfigFormat): string {
  return format === "json" ? configTomlPathWith(path, cwd) : configJsonPathWith(path, cwd);
}

/**
 * Deep-merges a `[remotes.*]` subtree over the base document: nested objects merge recursively,
 * arrays and scalars replace wholesale. Operates on the raw, pre-decode document so only keys
 * the remote block actually declares override the base — the remote section's schema defaults
 * never leak in.
 */
function mergeRemoteSubtree(
  base: Record<string, unknown>,
  remote: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(remote)) {
    const existing = Object.hasOwn(result, key) ? result[key] : undefined;
    setOwnProperty(
      result,
      key,
      isObject(existing) && isObject(value) ? mergeRemoteSubtree(existing, value) : value,
    );
  }
  return result;
}

/** Whether a remote subtree explicitly declares `db.seed.enabled`. */
function remoteSetsDbSeedEnabled(remote: Record<string, unknown>): boolean {
  const db = remote["db"];
  const seed = isObject(db) ? db["seed"] : undefined;
  return isObject(seed) && "enabled" in seed;
}

/** Forces `db.seed.enabled = false`, immutably. */
function withDbSeedDisabled(document: Record<string, unknown>): Record<string, unknown> {
  const db = isObject(document["db"]) ? document["db"] : {};
  const seed = isObject(db["seed"]) ? db["seed"] : {};
  return { ...document, db: { ...db, seed: { ...seed, enabled: false } } };
}

function collectLeafPaths(value: unknown, prefix: ReadonlyArray<string> = []): Array<string[]> {
  if (!isObject(value)) {
    return [Array.from(prefix)];
  }

  return Object.entries(value).flatMap(([key, child]) => collectLeafPaths(child, [...prefix, key]));
}

function pathKey(path: ReadonlyArray<string>): string {
  return JSON.stringify(path);
}

/**
 * Builds a `project_id -> "[remotes.<name>]"` map across every `[remotes.*]` block, failing on
 * the first duplicate. {@link applyRemoteOverride} only invokes this when `goViperCompat` is
 * set, so it runs even for callers that don't request a specific `projectRef`. A missing
 * `project_id` reads as `""`, so two remotes that both omit it collide on the empty key.
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

/**
 * Extracts `project_id` for every `[remotes.<name>]` block, in document order, reading a
 * missing field as `""`. Returns `[]` for anything that isn't a `remotes` table.
 */
export function remoteProjectIdEntries(
  remotes: unknown,
): ReadonlyArray<{ readonly name: string; readonly projectId: string }> {
  if (!isObject(remotes)) {
    return [];
  }
  return Object.entries(remotes).map(([name, remote]) => ({
    name,
    projectId:
      isObject(remote) && typeof remote["project_id"] === "string" ? remote["project_id"] : "",
  }));
}

/**
 * The name of the `[remotes.<name>]` block whose `project_id` equals `projectRef`, or
 * `undefined` when none matches (including when `projectRef` itself is `undefined`). Matches
 * against the raw, pre-`env()` literal — callers must pass `LoadedCliConfig.rawDocument`'s
 * `remotes`, never `LoadedCliConfig.document`, so a `project_id = "env(REF)"` that resolves to
 * `REF` doesn't match a caller-supplied, already-resolved `REF`.
 */
export function remoteNameForProjectRef(
  remotes: unknown,
  projectRef: string | undefined,
): string | undefined {
  if (projectRef === undefined) {
    return undefined;
  }
  return remoteProjectIdEntries(remotes).find((entry) => entry.projectId === projectRef)?.name;
}

/** Valid project ref format: exactly 20 lowercase ASCII letters. */
const REMOTE_PROJECT_ID_PATTERN = /^[a-z]{20}$/;

/**
 * Rejects the first `[remotes.*]` block whose `project_id` is not a valid project ref, across
 * every remote regardless of selection. Unlike {@link checkDuplicateRemoteProjectIds}, this must
 * see the already-interpolated `project_id`: a `project_id = "env(REF)"` that resolves to a
 * valid ref passes here even though the raw literal doesn't match the pattern.
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
 * Applies the `[remotes.<name>]` override whose `project_id` matches `projectRef` to
 * `rawDocument`, matching against the raw, pre-`env()` literal so an unresolved `env(...)`
 * reference is matched by its literal form, not its resolved value. Returns the merged, still
 * pre-interpolation document (`remotes` stripped) and the matched name; an absent or unmatched
 * `projectRef` returns the base document verbatim.
 */
const applyRemoteOverride = Effect.fnUntraced(function* (
  rawDocument: Record<string, unknown>,
  interpolatedRemotes: Record<string, unknown> | undefined,
  projectRef: string | undefined,
  goViperCompat: boolean,
) {
  const remotes = rawDocument["remotes"];
  if (!isObject(remotes)) {
    return {
      document: rawDocument,
      appliedRemote: undefined as string | undefined,
      remoteLeafPaths: [],
    };
  }
  if (goViperCompat) {
    yield* checkDuplicateRemoteProjectIds(remotes);
    yield* checkRemoteProjectIdFormat(interpolatedRemotes ?? remotes);
  }
  const name = remoteNameForProjectRef(remotes, projectRef);
  if (name === undefined) {
    return {
      document: rawDocument,
      appliedRemote: undefined as string | undefined,
      remoteLeafPaths: [],
    };
  }
  const remoteSubtree = remotes[name];
  const remoteLeafPaths = collectLeafPaths(remoteSubtree);
  let merged = isObject(remoteSubtree)
    ? mergeRemoteSubtree(rawDocument, remoteSubtree)
    : { ...rawDocument };
  if (!(isObject(remoteSubtree) && remoteSetsDbSeedEnabled(remoteSubtree))) {
    merged = withDbSeedDisabled(merged);
  }
  delete merged["remotes"];
  return { document: merged, appliedRemote: name, remoteLeafPaths };
});

function parseCliConfigDocument(content: string, format: ConfigFormat): unknown {
  return format === "json" ? JSON.parse(content) : SmolToml.parse(content);
}

interface NormalizedSMTPDocument {
  readonly document: unknown;
  /** Section paths that used the deprecated `inbucket` key, e.g. `inbucket`, `remotes.staging.inbucket`. */
  readonly deprecatedSections: ReadonlyArray<string>;
}

/**
 * Rewrites the deprecated `[inbucket]` config section (top-level and per `[remotes.*]`) to its
 * preferred `[local_smtp]` name; when both are present, the explicit `local_smtp` wins.
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
  /** Provider ids (`"linkedin"` | `"slack"`) whose deprecated top-level block was `enabled`. */
  readonly deprecatedProviders: ReadonlyArray<string>;
  /**
   * The removed top-level `auth.external.{linkedin,slack}` sub-objects (provider id → the
   * removed object), regardless of `enabled`. A caller checking these for an `encrypted:`
   * secret against the already-stripped {@link LoadedCliConfig.document} can fold this back in.
   * Only the top-level blocks are captured, not any surviving `remotes.*.auth.external.*`.
   */
  readonly removedProviders: Readonly<Record<string, unknown>>;
}

const DEPRECATED_EXTERNAL_PROVIDERS = ["linkedin", "slack"] as const;

/**
 * Strips the deprecated `auth.external.{linkedin,slack}` providers, unconditionally, reporting
 * one only when it was `enabled`. Runs on the post-remote-merge document, since only the final
 * merged config's `auth.external` matters. Also strips (without reporting) any surviving
 * `remotes.*.auth.external.{linkedin,slack}`, purely so an unselected remote's deprecated block
 * doesn't get rejected by this package's eager, whole-map schema decode.
 */
function normalizeDeprecatedExternalProviders(
  document: unknown,
): NormalizedExternalProvidersDocument {
  if (!isObject(document)) {
    return { document, deprecatedProviders: [], removedProviders: {} };
  }
  const normalized = { ...document };
  const deprecatedProviders: Array<string> = [];
  const removedProviders: Record<string, unknown> = {};
  if (isObject(normalized.auth) && isObject(normalized.auth.external)) {
    const external = { ...normalized.auth.external };
    for (const ext of DEPRECATED_EXTERNAL_PROVIDERS) {
      const provider = external[ext];
      if (provider === undefined) continue;
      removedProviders[ext] = provider;
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
  return { document: normalized, deprecatedProviders, removedProviders };
}

/**
 * Wraps every `edge_runtime.secrets` value in `Redacted` before it's attached to
 * `CliConfigParseError.document`, so an uncaught parse error can't leak a resolved secret into
 * a log or trace. Callers must unwrap via `Redacted.value` before re-decoding.
 */
function redactEdgeRuntimeSecrets(edgeRuntime: unknown): unknown {
  if (!isObject(edgeRuntime) || !("secrets" in edgeRuntime)) {
    return edgeRuntime;
  }
  if (!isObject(edgeRuntime.secrets)) {
    // A malformed `secrets` field (e.g. a TOML array instead of a table) still carries a
    // secret in its structure, so wrap it as one unit. Guarded by `"secrets" in edgeRuntime` so
    // a document that legitimately omits `secrets` doesn't gain a spurious `Redacted` field.
    return {
      ...edgeRuntime,
      secrets: Redacted.make(edgeRuntime.secrets, { label: "edge_runtime.secrets" }),
    };
  }
  return {
    ...edgeRuntime,
    // Wraps the whole entry, not just string values: a malformed entry (e.g. a TOML array)
    // still carries a secret in its structure, and `Redacted.make` accepts any value.
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

  const schemaRef = document[cliConfigSchemaKey];
  return typeof schemaRef === "string" ? schemaRef : undefined;
}

function parseCliConfig(
  document: unknown,
  format: ConfigFormat,
  path: string,
  appliedRemote: string | undefined,
): Effect.Effect<CliConfig, CliConfigParseError> {
  return validateCliConfig(document).pipe(
    Effect.mapError(
      (cause) =>
        new CliConfigParseError({
          path,
          format,
          cause,
          document: isObject(document)
            ? { edge_runtime: redactEdgeRuntimeSecrets(document.edge_runtime) }
            : undefined,
          appliedRemote,
        }),
    ),
  );
}

export interface DecodeCliConfigDocumentForValidationEffectOptions {
  /**
   * The config file path `document` would be written to (or was read from); used only to locate
   * the project's `.env`/`.env.local` files and to attach to a decode failure's
   * `CliConfigParseError.path`/`.format`. Never read or written itself.
   */
  readonly path: string;
  readonly format: ConfigFormat;
  readonly goViperCompat?: boolean;
  /**
   * When set, merges the `[remotes.<remoteName>]` block over the root before decoding, so it's
   * checked against the root's full business rules instead of the relaxed treatment an
   * unselected remote block gets. A name matching no block under `document.remotes` is a no-op.
   */
  readonly remoteName?: string;
}

/**
 * Merges the `[remotes.<remoteName>]` block of `document`'s own `remotes` map over `document`
 * itself, using the same merge {@link applyRemoteOverride} runs for a matched remote — except
 * the caller already knows which remote it wants. Returns `document` unchanged, with
 * `appliedRemote: undefined`, when `remoteName` is omitted or unmatched.
 */
function mergeSelectedRemoteForValidation(
  document: Record<string, unknown>,
  remoteName: string | undefined,
): { readonly document: Record<string, unknown>; readonly appliedRemote: string | undefined } {
  const remotes = document["remotes"];
  if (remoteName === undefined || !isObject(remotes) || !Object.hasOwn(remotes, remoteName)) {
    return { document, appliedRemote: undefined };
  }
  const remoteSubtree = remotes[remoteName];
  let merged = isObject(remoteSubtree)
    ? mergeRemoteSubtree(document, remoteSubtree)
    : { ...document };
  if (!(isObject(remoteSubtree) && remoteSetsDbSeedEnabled(remoteSubtree))) {
    merged = withDbSeedDisabled(merged);
  }
  delete merged["remotes"];
  return { document: merged, appliedRemote: remoteName };
}

/**
 * Decodes `document` — a full, raw `CliConfig` document shape, `remotes` intact — through the
 * same env-resolution + `[remotes.*]`-merge + schema-decode pipeline {@link loadCliConfigFile}
 * runs, without touching the filesystem for a raw parse. `env(VAR)` references resolve against
 * `.env`/`.env.local` under `options.path`'s project directory. `options.remoteName` lets a
 * caller validate the document as it would decode with one `[remotes.*]` block selected.
 */
export const decodeCliConfigDocumentForValidationEffect = Effect.fnUntraced(function* (
  document: Record<string, unknown>,
  options: DecodeCliConfigDocumentForValidationEffectOptions,
) {
  const path = yield* Path.Path;
  const projectRoot = path.dirname(path.dirname(options.path));
  const cliProjectEnv = yield* loadCliProjectEnvironment({
    cwd: projectRoot,
    baseEnv: process.env,
  });
  const goViperCompat = options.goViperCompat ?? false;

  const { document: documentForDecode, appliedRemote } = mergeSelectedRemoteForValidation(
    document,
    options.remoteName,
  );

  const interpolated = interpolateEnvReferencesAgainstSchema(
    documentForDecode,
    cliProjectEnv?.values ?? {},
    CliConfigSchema,
    { goViperCompat },
  );
  const { document: normalizedForDecode } = normalizeDeprecatedExternalProviders(interpolated);
  return yield* parseCliConfig(normalizedForDecode, options.format, options.path, appliedRemote);
});

export const configJsonPath = Effect.fnUntraced(function* (cwd: string) {
  const path = yield* Path.Path;
  const project = yield* findCliProjectPaths(cwd);
  return configJsonPathWith(path, project?.projectRoot ?? cwd);
});

export const configTomlPath = Effect.fnUntraced(function* (cwd: string) {
  const path = yield* Path.Path;
  const project = yield* findCliProjectPaths(cwd);
  return configTomlPathWith(path, project?.projectRoot ?? cwd);
});

export const loadCliConfigFile = Effect.fnUntraced(function* (
  filePath: string,
  options?: InternalLoadCliConfigOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const format = filePath.endsWith(".json") ? "json" : "toml";
  const content = yield* fs.readFileString(filePath);
  const document = yield* Effect.try({
    try: () => parseCliConfigDocument(content, format),
    catch: (cause) => new CliConfigParseError({ path: filePath, format, cause }),
  });
  const { document: normalized, deprecatedSections } = normalizeDeprecatedSMTPSections(document);
  // Warn on stderr, writing directly to the real console (bypassing whatever `Console.Console`
  // is ambient) so a caller wrapping this in a deferred/buffered console can't delay or
  // swallow it.
  for (const section of deprecatedSections) {
    const replacement = section.replace(/inbucket$/, "local_smtp");
    yield* Console.error(
      `WARN: config section [${section}] is deprecated. Please use [${replacement}] instead.`,
    ).pipe(Effect.provideService(Console.Console, globalThis.console));
  }

  // Substitute `env(VAR)` references against `.env`/`.env.local`/ambient env before schema
  // decode, since a numeric/boolean field would otherwise crash the strict decoder on a string.
  // The config file lives two directories under the project root `loadCliProjectEnvironment` expects.
  const projectRoot = path.dirname(path.dirname(filePath));
  const cliProjectEnv =
    options?.cliProjectEnv ??
    (yield* loadCliProjectEnvironment({
      cwd: projectRoot,
      baseEnv: process.env,
      search: options?.search,
    }));
  const goViperCompat = options?.goViperCompat ?? false;
  const interpolateDocument = (
    document: unknown,
    onResolvedEnv?: (path: ReadonlyArray<string>, envNames: ReadonlyArray<string>) => void,
  ): unknown =>
    interpolateEnvReferencesAgainstSchema(document, cliProjectEnv?.values ?? {}, CliConfigSchema, {
      goViperCompat,
      onResolvedEnv,
    });

  // Interpolated once here purely to give `applyRemoteOverride`'s format check (not its
  // match/merge) the resolved `remotes.*.project_id`.
  const interpolatedForValidation = interpolateDocument(normalized);
  const interpolatedRemotes =
    isObject(interpolatedForValidation) && isObject(interpolatedForValidation["remotes"])
      ? interpolatedForValidation["remotes"]
      : undefined;

  // Merge the matching `[remotes.*]` override over the raw, pre-`env()` document (see
  // `applyRemoteOverride`). The match/merge always runs; the duplicate-`project_id`/format
  // checks only run when `goViperCompat` is set.
  let documentForDecode: unknown = normalized;
  let appliedRemote: string | undefined;
  let remoteLeafPaths: Array<string[]> = [];
  if (isObject(normalized)) {
    const resolved = yield* applyRemoteOverride(
      normalized,
      interpolatedRemotes,
      options?.projectRef,
      goViperCompat,
    );
    documentForDecode = resolved.document;
    appliedRemote = resolved.appliedRemote;
    remoteLeafPaths = resolved.remoteLeafPaths;
  }

  // The merge above ran on the raw document, so any `env(...)` reference in the winning
  // remote's subtree (or elsewhere in the base) still needs resolving before decode. When no
  // remote matched this redundantly recomputes `interpolatedForValidation`'s substitutions, but
  // correctness on the match+`env()` path matters more than avoiding that.
  const resolvedEnvironmentPaths: Array<string[]> = [];
  const resolvedEnvironmentNames = new Map<string, ReadonlyArray<string>>();
  documentForDecode = isObject(documentForDecode)
    ? interpolateDocument(documentForDecode, (path, envNames) => {
        resolvedEnvironmentPaths.push(Array.from(path));
        resolvedEnvironmentNames.set(pathKey(Array.from(path)), envNames);
      })
    : documentForDecode;

  // Strip the deprecated `auth.external.{linkedin,slack}` provider ids from the post-remote-merge
  // document (see `normalizeDeprecatedExternalProviders`).
  const {
    document: normalizedForDecode,
    deprecatedProviders,
    removedProviders,
  } = normalizeDeprecatedExternalProviders(documentForDecode);
  // Pinned to the real console, same as the `[inbucket]` warning above.
  if (goViperCompat) {
    for (const ext of deprecatedProviders) {
      yield* Console.error(
        `WARN: disabling deprecated "${ext}" provider. Please use [auth.external.${ext}_oidc] instead`,
      ).pipe(Effect.provideService(Console.Console, globalThis.console));
    }
  }

  const config = yield* parseCliConfig(normalizedForDecode, format, filePath, appliedRemote);

  const localPathKeys = new Set(collectLeafPaths(normalized).map(pathKey));
  const remotePathKeys = new Set(remoteLeafPaths.map(pathKey));
  const environmentPathKeys = new Set(resolvedEnvironmentPaths.map(pathKey));
  const valueOrigins = isObject(normalizedForDecode)
    ? collectLeafPaths(normalizedForDecode).flatMap((path) => {
        const key = pathKey(path);
        const source: CliConfigValueSource | undefined = environmentPathKeys.has(key)
          ? "environment"
          : remotePathKeys.has(key)
            ? "remote"
            : localPathKeys.has(key)
              ? "local"
              : undefined;
        if (source === undefined) {
          return [];
        }
        const envVariables =
          source === "environment" ? resolvedEnvironmentNames.get(key) : undefined;
        return [{ path, source, ...(envVariables === undefined ? {} : { envVariables }) }];
      })
    : [];

  return {
    path: filePath,
    format,
    config,
    schemaRef: getSchemaRef(document),
    ignoredPaths: [],
    rawText: content,
    document: isObject(normalizedForDecode) ? normalizedForDecode : undefined,
    rawDocument: isObject(normalized) ? normalized : undefined,
    interpolatedRemotes,
    appliedRemote,
    removedDeprecatedExternalProviders: removedProviders,
    valueOrigins,
  } satisfies LoadedCliConfig;
});

export const loadCliConfig = Effect.fnUntraced(function* (
  cwd: string,
  options?: InternalLoadCliConfigOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const project = yield* findCliProjectPaths(cwd, { search: options?.search });

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
    const json = yield* loadCliConfigFile(jsonPath, options);

    return {
      ...json,
      ignoredPaths: (yield* fs.exists(tomlPath)) ? [tomlPath] : [],
    } satisfies LoadedCliConfig;
  }

  if (yield* fs.exists(tomlPath)) {
    return yield* loadCliConfigFile(tomlPath, options);
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

export const saveCliConfig = Effect.fnUntraced(function* (options: SaveCliConfigOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const project = yield* findCliProjectPaths(options.cwd);
  const baseCwd = project?.projectRoot ?? options.cwd;
  const format = yield* resolveSaveFormat(baseCwd, options.format);
  const existingConfig =
    options.schemaRef !== undefined || project === null ? null : yield* loadCliConfig(baseCwd);
  const schemaRef = options.schemaRef ?? existingConfig?.schemaRef;
  const filePath =
    format === "json" ? configJsonPathWith(path, baseCwd) : configTomlPathWith(path, baseCwd);
  const siblingPath = siblingConfigPathWith(path, baseCwd, format);
  const content =
    format === "json"
      ? encodeCliConfigToJsonDocument(options.config, schemaRef)
      : encodeCliConfigToTomlDocument(options.config, schemaRef);

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
  } satisfies LoadedCliConfig;
});

/**
 * Fallback mode for a freshly created config file, when no existing file's
 * mode is available to copy — matches the `0644` a plain `touch`/`install`
 * produces under the common `022` umask.
 */
const DEFAULT_CLI_CONFIG_FILE_MODE = 0o644;

/**
 * Atomically replaces `filePath`'s content: writes a temp file in the same directory with the
 * target's current mode (or {@link DEFAULT_CLI_CONFIG_FILE_MODE} if none exists) applied at
 * creation — not via a later `chmod` — so a restrictive file is never briefly more permissive,
 * then renames over the target. Unlike {@link writeFileAtomic}, this surfaces a typed
 * {@link CliConfigWriteError} instead of dying on failure.
 */
export const writeCliConfigDocumentText = Effect.fnUntraced(function* (
  filePath: string,
  content: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const tmpPath = `${filePath}.tmp.${Date.now()}.${randomBytes(3).toString("hex")}`;

  yield* Effect.gen(function* () {
    const mode = yield* fs.stat(filePath).pipe(
      Effect.map((info) => info.mode & 0o7777),
      Effect.catchTag("PlatformError", (error) =>
        Predicate.isTagged(error.reason, "NotFound")
          ? Effect.succeed(DEFAULT_CLI_CONFIG_FILE_MODE)
          : Effect.fail(error),
      ),
    );
    yield* fs.writeFileString(tmpPath, content, { mode });
    yield* fs.rename(tmpPath, filePath);
  }).pipe(
    Effect.ensuring(fs.remove(tmpPath).pipe(Effect.ignore)),
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        new CliConfigWriteError({
          path: filePath,
          cause,
          message: `Failed to write ${filePath}: ${cause.message}`,
        }),
      ),
    ),
  );
});
