import { Effect, FileSystem, Path, Schema } from "effect";
import * as SmolToml from "smol-toml";
import { ProjectConfigSchema, type ProjectConfig } from "./base.ts";
import { DuplicateRemoteProjectIdError, ProjectConfigParseError } from "./errors.ts";
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
 * When `projectRef` is set, the matching `[remotes.<name>]` block (the one whose
 * `project_id` equals it) is merged over the base config before decode, mirroring
 * Go's `config.Load` with `Config.ProjectId` set
 * (`apps/cli-go/pkg/config/config.go:503-562`). Omitting it loads the base config
 * verbatim, so existing callers are unaffected.
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
}

export interface SaveProjectConfigOptions {
  readonly cwd: string;
  readonly config: ProjectConfig;
  readonly format?: ConfigFormat;
  readonly schemaRef?: string;
}

const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);
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
 * Applies the `[remotes.<name>]` override whose `project_id` matches `projectRef`
 * to `document`, mirroring Go's `loadFromFile` remote resolution
 * (`config.go:503-518`). Returns the merged document (with `remotes` stripped) and
 * the matched remote name.
 *
 * Like Go, duplicate `project_id`s are detected across *all* `[remotes.*]` blocks —
 * not just the ones matching `projectRef` — before the matching override is applied.
 * A missing `project_id` reads as `""` (Go's `viper.GetString`), so two remotes that
 * both omit it collide on the empty key and fail just as in Go.
 */
const applyRemoteOverride = Effect.fnUntraced(function* (
  document: Record<string, unknown>,
  projectRef: string,
) {
  const remotes = document["remotes"];
  if (!isObject(remotes)) {
    return { document, appliedRemote: undefined as string | undefined };
  }
  // Build a project_id -> "[remotes.<name>]" map over every remote, failing on the
  // first duplicate, then resolve the single block matching projectRef.
  const idToName = new Map<string, string>();
  let name: string | undefined;
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
    if (projectId === projectRef) {
      name = remoteName;
    }
  }
  if (name === undefined) {
    return { document, appliedRemote: undefined as string | undefined };
  }
  const remoteSubtree = remotes[name];
  let merged = isObject(remoteSubtree)
    ? mergeRemoteSubtree(document, remoteSubtree)
    : { ...document };
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
): Effect.Effect<ProjectConfig, ProjectConfigParseError> {
  return Effect.try({
    try: () => decodeProjectConfig(document),
    catch: (cause) => new ProjectConfigParseError({ path, format, cause }),
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
    }));
  const interpolated = interpolateEnvReferencesAgainstSchema(
    document,
    projectEnv?.values ?? {},
    ProjectConfigSchema,
  );

  // Merge the matching `[remotes.*]` override over the base document before
  // decode (Go's `loadFromFile` with `Config.ProjectId` set). Only requested
  // when a `projectRef` is supplied, so other callers load the base verbatim.
  let documentForDecode: unknown = interpolated;
  let appliedRemote: string | undefined;
  if (options?.projectRef !== undefined && isObject(interpolated)) {
    const resolved = yield* applyRemoteOverride(interpolated, options.projectRef);
    documentForDecode = resolved.document;
    appliedRemote = resolved.appliedRemote;
  }

  const config = yield* parseProjectConfig(documentForDecode, format, filePath);

  return {
    path: filePath,
    format,
    config,
    schemaRef: getSchemaRef(document),
    ignoredPaths: [],
    document: isObject(documentForDecode) ? documentForDecode : undefined,
    appliedRemote,
  } satisfies LoadedProjectConfig;
});

export const loadProjectConfig = Effect.fnUntraced(function* (
  cwd: string,
  options?: LoadProjectConfigOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const project = yield* findProjectPaths(cwd);

  if (project === null) {
    return null;
  }

  const jsonPath = project.configPath.endsWith(".json")
    ? project.configPath
    : project.configPath.replace(/config\.toml$/, "config.json");
  const tomlPath = project.configPath.endsWith(".toml")
    ? project.configPath
    : project.configPath.replace(/config\.json$/, "config.toml");

  if (yield* fs.exists(jsonPath)) {
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
