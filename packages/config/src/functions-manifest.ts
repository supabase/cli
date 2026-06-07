import { Effect, FileSystem, Path, Schema } from "effect";
import { ProjectConfigSchema, type ProjectConfig } from "./base.ts";
import { loadProjectConfig } from "./io.ts";
import { findProjectPaths } from "./paths.ts";

const functionSlugPattern = /^[a-zA-Z0-9_-]+$/;
const decodeProjectConfig = Schema.decodeUnknownSync(ProjectConfigSchema);
const emptyConfig = decodeProjectConfig({});

export const edgeFunctionsDirectoryName = "functions";
export const edgeFunctionEntrypointFileName = "index.ts";
export const edgeFunctionDenoConfigFileName = "deno.json";

export interface ResolvedFunctionConfig {
  readonly enabled: boolean;
  readonly verify_jwt: boolean;
  readonly import_map: string;
  readonly entrypoint: string;
  readonly static_files: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export type FunctionsManifest = Readonly<Record<string, ResolvedFunctionConfig>>;

interface InferFunctionsManifestOptions {
  readonly cwd: string;
  readonly config?: ProjectConfig;
}

function filesystemFunctionConfig(slug: string, hasDenoJson: boolean): ResolvedFunctionConfig {
  return {
    enabled: true,
    verify_jwt: true,
    import_map: hasDenoJson
      ? `./${edgeFunctionsDirectoryName}/${slug}/${edgeFunctionDenoConfigFileName}`
      : "",
    entrypoint: `./${edgeFunctionsDirectoryName}/${slug}/${edgeFunctionEntrypointFileName}`,
    static_files: [],
    env: {},
  };
}

function defaultFunctionConfig(slug: string): ResolvedFunctionConfig {
  return filesystemFunctionConfig(slug, false);
}

function hasFunctionOverride(config: ResolvedFunctionConfig): boolean {
  return (
    config.enabled !== true ||
    config.verify_jwt !== true ||
    config.import_map !== "" ||
    config.entrypoint !== "" ||
    config.static_files.length > 0 ||
    Object.keys(config.env).length > 0
  );
}

function applyFunctionOverride(
  base: ResolvedFunctionConfig,
  override: ResolvedFunctionConfig | undefined,
): ResolvedFunctionConfig {
  if (override === undefined) {
    return base;
  }

  return {
    enabled: override.enabled === true ? base.enabled : override.enabled,
    verify_jwt: override.verify_jwt === true ? base.verify_jwt : override.verify_jwt,
    import_map: override.import_map === "" ? base.import_map : override.import_map,
    entrypoint: override.entrypoint === "" ? base.entrypoint : override.entrypoint,
    static_files: override.static_files.length === 0 ? base.static_files : override.static_files,
    env: Object.keys(override.env).length === 0 ? base.env : override.env,
  };
}

export const inferFunctionsManifest = Effect.fnUntraced(function* (
  options: InferFunctionsManifestOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectPaths = yield* findProjectPaths(options.cwd);
  const projectRoot = projectPaths?.projectRoot ?? options.cwd;
  const config =
    options.config ??
    (yield* loadProjectConfig(options.cwd).pipe(
      Effect.map((loaded) => loaded?.config ?? emptyConfig),
    ));
  const functionsDir = path.join(projectRoot, "supabase", edgeFunctionsDirectoryName);
  const filesystemFunctions: Record<string, ResolvedFunctionConfig> = {};

  if (yield* fs.exists(functionsDir)) {
    const entries = yield* fs.readDirectory(functionsDir);
    for (const slug of entries.sort((left, right) => left.localeCompare(right))) {
      if (!functionSlugPattern.test(slug)) {
        continue;
      }

      const entrypointPath = path.join(functionsDir, slug, edgeFunctionEntrypointFileName);
      if (!(yield* fs.exists(entrypointPath))) {
        continue;
      }

      filesystemFunctions[slug] = filesystemFunctionConfig(
        slug,
        yield* fs.exists(path.join(functionsDir, slug, edgeFunctionDenoConfigFileName)),
      );
    }
  }

  const slugs = [
    ...new Set([...Object.keys(filesystemFunctions), ...Object.keys(config.functions)]),
  ].sort((left, right) => left.localeCompare(right));
  const manifest: Record<string, ResolvedFunctionConfig> = {};

  for (const slug of slugs) {
    const override = config.functions[slug];
    const base = filesystemFunctions[slug] ?? defaultFunctionConfig(slug);
    if (
      filesystemFunctions[slug] === undefined &&
      override !== undefined &&
      !hasFunctionOverride(override)
    ) {
      continue;
    }

    manifest[slug] = applyFunctionOverride(base, override);
  }

  return manifest;
});
