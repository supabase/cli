import { Effect, FileSystem, Path, Schema } from "effect";
import * as SmolToml from "smol-toml";
import { ProjectConfigSchema, type ProjectConfig } from "./base.ts";
import { ProjectConfigParseError } from "./errors.ts";
import { findProjectPaths } from "./paths.ts";

const projectConfigSchemaKey = "$schema";

export type ConfigFormat = "json" | "toml";

export interface LoadedProjectConfig {
  readonly path: string;
  readonly format: ConfigFormat;
  readonly config: ProjectConfig;
  readonly schemaRef?: string;
  readonly ignoredPaths: ReadonlyArray<string>;
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

function encodeMinimalProjectConfig(config: ProjectConfig): Record<string, unknown> {
  const encoded = encodeProjectConfig(config);
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

export const loadProjectConfigFile = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const format = path.endsWith(".json") ? "json" : "toml";
  const content = yield* fs.readFileString(path);
  const document = yield* Effect.try({
    try: () => parseProjectConfigDocument(content, format),
    catch: (cause) => new ProjectConfigParseError({ path, format, cause }),
  });
  const config = yield* parseProjectConfig(document, format, path);

  return {
    path,
    format,
    config,
    schemaRef: getSchemaRef(document),
    ignoredPaths: [],
  } satisfies LoadedProjectConfig;
});

export const loadProjectConfig = Effect.fnUntraced(function* (cwd: string) {
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
    const json = yield* loadProjectConfigFile(jsonPath);

    return {
      ...json,
      ignoredPaths: (yield* fs.exists(tomlPath)) ? [tomlPath] : [],
    } satisfies LoadedProjectConfig;
  }

  if (yield* fs.exists(tomlPath)) {
    return yield* loadProjectConfigFile(tomlPath);
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
