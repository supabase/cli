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
  selectRemote?: (remotes: Record<string, unknown>) => string | undefined,
) {
  const remotes = rawDocument["remotes"];
  if (!isObject(remotes)) {
    return {
      document: rawDocument,
      appliedRemote: undefined as string | undefined,
      remoteLeafPaths: [],
    };
  }
  if (goViperCompat && selectRemote === undefined) {
    yield* checkDuplicateRemoteProjectIds(remotes);
    yield* checkRemoteProjectIdFormat(interpolatedRemotes ?? remotes);
  }
  const selected = selectRemote?.(remotes);
  const name =
    selectRemote === undefined
      ? remoteNameForProjectRef(remotes, projectRef)
      : selected !== undefined && Object.hasOwn(remotes, selected)
        ? selected
        : undefined;
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

export interface NormalizedOrioleDBVersionDocument {
  readonly document: unknown;
  /**
   * Dotted paths whose legacy `experimental.orioledb_version` was non-empty, e.g.
   * `experimental.orioledb_version` or `remotes.staging.experimental.orioledb_version`. Emitted
   * whether or not the value was actually promoted (an explicit `db.orioledb_version` still
   * wins, but the legacy key is deprecated either way).
   */
  readonly deprecatedPaths: ReadonlyArray<string>;
}

/**
 * Moves a section's string `experimental.orioledb_version` out of `experimental`, promoting a
 * non-empty value to `db.orioledb_version` when that is absent or `""` (the init template always
 * writes `""`). Non-string values, a non-empty `db.orioledb_version`, and a non-table `db` are
 * left untouched so schema validation still sees them.
 */
function promoteOrioleDBVersion(section: Record<string, unknown>): {
  readonly section: Record<string, unknown>;
  readonly warned: boolean;
} {
  const experimental = section.experimental;
  if (!isObject(experimental) || !("orioledb_version" in experimental)) {
    return { section, warned: false };
  }
  const legacyValue = experimental.orioledb_version;
  if (typeof legacyValue !== "string") {
    return { section, warned: false };
  }
  const legacyNonEmpty = legacyValue.length > 0;

  const normalizedExperimental = { ...experimental };
  delete normalizedExperimental.orioledb_version;
  const normalizedSection: Record<string, unknown> = {
    ...section,
    experimental: normalizedExperimental,
  };

  if (!legacyNonEmpty) {
    return { section: normalizedSection, warned: false };
  }
  if ("db" in section && !isObject(section.db)) {
    return { section: normalizedSection, warned: true };
  }

  const db = isObject(section.db) ? section.db : undefined;
  const dbValue = db?.orioledb_version;
  const dbCanBePromotedOver = dbValue === undefined || dbValue === "";
  if (dbCanBePromotedOver) {
    normalizedSection.db = { ...db, orioledb_version: legacyValue };
  }

  return { section: normalizedSection, warned: true };
}

/**
 * Rewrites the deprecated `experimental.orioledb_version` (top-level and per `[remotes.*]`) to
 * `db.orioledb_version`, following the same shape as {@link normalizeDeprecatedSMTPSections}.
 * Exposed via `@supabase/config/internal` so `apps/cli`'s raw TOML reader
 * (`db-config.toml-read.ts`) can apply the same precedence before its own `[remotes.*]` merge.
 */
export function normalizeDeprecatedOrioleDBVersion(
  document: unknown,
): NormalizedOrioleDBVersionDocument {
  if (!isObject(document)) {
    return { document, deprecatedPaths: [] };
  }
  const deprecatedPaths: Array<string> = [];
  let normalized: Record<string, unknown> = { ...document };

  const top = promoteOrioleDBVersion(normalized);
  normalized = top.section;
  if (top.warned) {
    deprecatedPaths.push("experimental.orioledb_version");
  }

  if (isObject(normalized.remotes)) {
    normalized = {
      ...normalized,
      remotes: Object.fromEntries(
        Object.entries(normalized.remotes).map(([name, remote]) => {
          if (!isObject(remote)) {
            return [name, remote];
          }
          const result = promoteOrioleDBVersion(remote);
          if (result.warned) {
            deprecatedPaths.push(`remotes.${name}.experimental.orioledb_version`);
          }
          return [name, result.section];
        }),
      ),
    };
  }

  return { document: normalized, deprecatedPaths };
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
export const decodeCliConfigDocumentForValidationEffect = Effect.fn(
  "CliConfig.decodeForValidation",
)(function* (
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

const readAndNormalizeCliConfigFile = Effect.fnUntraced(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const format = filePath.endsWith(".json") ? "json" : "toml";
  const content = yield* fs.readFileString(filePath);
  const document = yield* Effect.try({
    try: () => parseCliConfigDocument(content, format),
    catch: (cause) => new CliConfigParseError({ path: filePath, format, cause }),
  });
  const { document: smtpNormalized, deprecatedSections } =
    normalizeDeprecatedSMTPSections(document);
  const { document: normalized, deprecatedPaths: deprecatedOrioleDBPaths } =
    normalizeDeprecatedOrioleDBVersion(smtpNormalized);
  // Warn on stderr, writing directly to the real console (bypassing whatever `Console.Console`
  // is ambient) so a caller wrapping this in a deferred/buffered console can't delay or
  // swallow it.
  for (const section of deprecatedSections) {
    const replacement = section.replace(/inbucket$/, "local_smtp");
    yield* Console.error(
      `WARN: config section [${section}] is deprecated. Please use [${replacement}] instead.`,
    ).pipe(Effect.provideService(Console.Console, globalThis.console));
  }
  for (const path of deprecatedOrioleDBPaths) {
    const replacement = path.replace(/experimental\.orioledb_version$/, "db.orioledb_version");
    yield* Console.error(`WARN: ${path} is deprecated. Please use ${replacement} instead.`).pipe(
      Effect.provideService(Console.Console, globalThis.console),
    );
  }
  return { format, content, document, normalized } as const;
});

/**
 * Not covered by semver — exported from `@supabase/config/internal` only. The output of the
 * parse + merge stage: the raw document with the selected `[remotes.*]` block merged in, still
 * pre-`env()`-interpolation and pre-decode.
 */
export interface MergedCliConfigDocument {
  readonly path: string;
  readonly format: ConfigFormat;
  readonly rawText: string;
  readonly schemaRef: string | undefined;
  readonly ignoredPaths: ReadonlyArray<string>;
  /** The document as parsed and deprecation-normalized, before any `[remotes.*]` merge. */
  readonly rawDocument: Record<string, unknown> | undefined;
  /** The merged document; `remotes` is stripped when a block matched. */
  readonly document: unknown;
  readonly appliedRemote: string | undefined;
  readonly remoteLeafPaths: ReadonlyArray<ReadonlyArray<string>>;
  /** Present when the producing stage already interpolated the `remotes` table. */
  readonly interpolatedRemotes?: Record<string, unknown>;
}

/**
 * Not covered by semver — exported from `@supabase/config/internal` only.
 */
export interface ParseMergeCliConfigOptions {
  /** See {@link FindCliProjectPathsOptions.search}. */
  readonly search?: boolean;
  /** Skip the `config.json`-over-`config.toml` preference and only ever load `config.toml`. */
  readonly tomlOnly?: boolean;
  /**
   * Picks the `[remotes.<name>]` block to merge from the raw `remotes` table. The caller owns
   * remote selection, so the `project_id` duplicate and format checks are not run here.
   */
  readonly selectRemote: (remotes: Record<string, unknown>) => string | undefined;
}

const mergeRemoteForLoad = (
  normalized: unknown,
  interpolatedRemotes: Record<string, unknown> | undefined,
  projectRef: string | undefined,
  goViperCompat: boolean,
  selectRemote?: (remotes: Record<string, unknown>) => string | undefined,
): Effect.Effect<
  {
    readonly document: unknown;
    readonly appliedRemote: string | undefined;
    readonly remoteLeafPaths: ReadonlyArray<string[]>;
  },
  DuplicateRemoteProjectIdError | InvalidRemoteProjectIdError
> =>
  isObject(normalized)
    ? applyRemoteOverride(normalized, interpolatedRemotes, projectRef, goViperCompat, selectRemote)
    : Effect.succeed({ document: normalized, appliedRemote: undefined, remoteLeafPaths: [] });

/**
 * Not covered by semver — exported from `@supabase/config/internal` only. Stage two of the
 * pipeline: interpolates `env()` references against `options.envValues`, strips the deprecated
 * external providers, and decodes + validates. `options.document` replaces the merged document,
 * so a caller can decode a document it has overlaid with effective values.
 */
export interface DecodeMergedCliConfigOptions {
  readonly envValues: Readonly<Record<string, string>>;
  readonly goViperCompat?: boolean;
  readonly document?: Record<string, unknown>;
}

export const decodeMergedCliConfig = Effect.fn("CliConfig.decodeMerged")(function* (
  merged: MergedCliConfigDocument,
  options: DecodeMergedCliConfigOptions,
) {
  const goViperCompat = options.goViperCompat ?? false;
  const interpolateDocument = (
    document: unknown,
    onResolvedEnv?: (path: ReadonlyArray<string>, envNames: ReadonlyArray<string>) => void,
  ): unknown =>
    interpolateEnvReferencesAgainstSchema(document, options.envValues, CliConfigSchema, {
      goViperCompat,
      onResolvedEnv,
    });

  let interpolatedRemotes = merged.interpolatedRemotes;
  if (interpolatedRemotes === undefined) {
    const interpolated = interpolateDocument(merged.rawDocument);
    interpolatedRemotes =
      isObject(interpolated) && isObject(interpolated["remotes"])
        ? interpolated["remotes"]
        : undefined;
  }

  // The merge ran on the raw document, so any `env(...)` reference in the winning
  // remote's subtree (or elsewhere in the base) still needs resolving before decode. When no
  // remote matched this redundantly recomputes the substitutions the legacy caller already did,
  // but correctness on the match+`env()` path matters more than avoiding that.
  const resolvedEnvironmentPaths: Array<string[]> = [];
  const resolvedEnvironmentNames = new Map<string, ReadonlyArray<string>>();
  const documentToDecode: unknown = options.document ?? merged.document;
  const documentForDecode = isObject(documentToDecode)
    ? interpolateDocument(documentToDecode, (path, envNames) => {
        resolvedEnvironmentPaths.push(Array.from(path));
        resolvedEnvironmentNames.set(pathKey(Array.from(path)), envNames);
      })
    : documentToDecode;

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

  const config = yield* parseCliConfig(
    normalizedForDecode,
    merged.format,
    merged.path,
    merged.appliedRemote,
  );

  const localPathKeys = new Set(collectLeafPaths(merged.rawDocument).map(pathKey));
  const remotePathKeys = new Set(merged.remoteLeafPaths.map(pathKey));
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
    path: merged.path,
    format: merged.format,
    config,
    schemaRef: merged.schemaRef,
    ignoredPaths: merged.ignoredPaths,
    rawText: merged.rawText,
    document: isObject(normalizedForDecode) ? normalizedForDecode : undefined,
    rawDocument: merged.rawDocument,
    interpolatedRemotes,
    appliedRemote: merged.appliedRemote,
    removedDeprecatedExternalProviders: removedProviders,
    valueOrigins,
  } satisfies LoadedCliConfig;
});

export const loadCliConfigFile = Effect.fn("CliConfig.loadFile")(function* (
  filePath: string,
  options?: InternalLoadCliConfigOptions,
) {
  const path = yield* Path.Path;
  const { format, content, document, normalized } = yield* readAndNormalizeCliConfigFile(filePath);

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
  const envValues = cliProjectEnv?.values ?? {};

  // Interpolated once here purely to give `applyRemoteOverride`'s format check (not its
  // match/merge) the resolved `remotes.*.project_id`.
  const interpolatedForValidation = interpolateEnvReferencesAgainstSchema(
    normalized,
    envValues,
    CliConfigSchema,
    { goViperCompat },
  );
  const interpolatedRemotes =
    isObject(interpolatedForValidation) && isObject(interpolatedForValidation["remotes"])
      ? interpolatedForValidation["remotes"]
      : undefined;

  // Merge the matching `[remotes.*]` override over the raw, pre-`env()` document (see
  // `applyRemoteOverride`). The match/merge always runs; the duplicate-`project_id`/format
  // checks only run when `goViperCompat` is set.
  const resolved = yield* mergeRemoteForLoad(
    normalized,
    interpolatedRemotes,
    options?.projectRef,
    goViperCompat,
  );

  return yield* decodeMergedCliConfig(
    {
      path: filePath,
      format,
      rawText: content,
      schemaRef: getSchemaRef(document),
      ignoredPaths: [],
      rawDocument: isObject(normalized) ? normalized : undefined,
      document: resolved.document,
      appliedRemote: resolved.appliedRemote,
      remoteLeafPaths: resolved.remoteLeafPaths,
      ...(interpolatedRemotes === undefined ? {} : { interpolatedRemotes }),
    },
    { envValues, goViperCompat },
  );
});

const locateCliConfigFile = Effect.fnUntraced(function* (
  cwd: string,
  options: { readonly search?: boolean; readonly tomlOnly?: boolean } | undefined,
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
    return {
      filePath: jsonPath,
      ignoredPaths: (yield* fs.exists(tomlPath)) ? [tomlPath] : [],
    };
  }

  if (yield* fs.exists(tomlPath)) {
    return { filePath: tomlPath, ignoredPaths: [] };
  }

  return null;
});

export const loadCliConfig = Effect.fn("CliConfig.load")(function* (
  cwd: string,
  options?: InternalLoadCliConfigOptions,
) {
  const located = yield* locateCliConfigFile(cwd, options);

  if (located === null) {
    return null;
  }

  const loaded = yield* loadCliConfigFile(located.filePath, options);
  return { ...loaded, ignoredPaths: located.ignoredPaths } satisfies LoadedCliConfig;
});

/**
 * Not covered by semver — exported from `@supabase/config/internal` only. Stage one of the
 * pipeline: discovers and parses the config file, then merges the `[remotes.*]` block chosen by
 * `options.selectRemote`. Returns `null` when no config file exists.
 */
export const parseMergeCliConfig = Effect.fn("CliConfig.parseMerge")(function* (
  cwd: string,
  options: ParseMergeCliConfigOptions,
) {
  const located = yield* locateCliConfigFile(cwd, options);

  if (located === null) {
    return null;
  }

  const { format, content, document, normalized } = yield* readAndNormalizeCliConfigFile(
    located.filePath,
  );
  const resolved = yield* mergeRemoteForLoad(
    normalized,
    undefined,
    undefined,
    false,
    options.selectRemote,
  );

  return {
    path: located.filePath,
    format,
    rawText: content,
    schemaRef: getSchemaRef(document),
    ignoredPaths: located.ignoredPaths,
    rawDocument: isObject(normalized) ? normalized : undefined,
    document: resolved.document,
    appliedRemote: resolved.appliedRemote,
    remoteLeafPaths: resolved.remoteLeafPaths,
  } satisfies MergedCliConfigDocument;
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

const DEFAULT_CLI_CONFIG_FILE_MODE = 0o644;

const writeFileAtomic = Effect.fnUntraced(function* (filePath: string, content: string) {
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
  }).pipe(Effect.ensuring(fs.remove(tmpPath).pipe(Effect.ignore)));
});

export const saveCliConfig = Effect.fn("CliConfig.save")(function* (options: SaveCliConfigOptions) {
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

/** Atomically replaces text while applying the target mode at creation to protect sensitive files. */
export const writeCliConfigDocumentText = Effect.fn("CliConfig.writeDocument")(function* (
  filePath: string,
  content: string,
) {
  yield* writeFileAtomic(filePath, content).pipe(
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
