import type { FileSystem, Path } from "effect";
import { Layer, ManagedRuntime } from "effect";
import type {
  LoadedProjectConfig,
  LoadProjectConfigOptions,
  SaveProjectConfigOptions,
} from "./config-document.ts";
import type { FunctionsManifest } from "./functions-manifest-model.ts";
import { inferFunctionsManifest } from "./functions-manifest.ts";
import type { ProjectPaths } from "./paths.ts";
import type { LoadProjectEnvironmentOptions, ProjectEnvironment } from "./project.ts";
import { loadProjectEnvironment } from "./project.ts";
import { findProjectPaths, findProjectRoot } from "./paths.ts";
import { projectConfigStoreLayer } from "./project-config.layer.ts";
import { ProjectConfigStore } from "./project-config.service.ts";

export interface ProjectConfigIo {
  readonly loadProjectConfig: (
    cwd: string,
    options?: LoadProjectConfigOptions,
  ) => Promise<LoadedProjectConfig | null>;
  readonly findProjectRootFor: (cwd: string) => Promise<string | null>;
  readonly findProjectPathsFor: (cwd: string) => Promise<ProjectPaths | null>;
  readonly loadProjectConfigFile: (path: string) => Promise<LoadedProjectConfig>;
  readonly loadProjectEnvironmentFor: (
    options: LoadProjectEnvironmentOptions,
  ) => Promise<ProjectEnvironment | null>;
  readonly saveProjectConfig: (options: SaveProjectConfigOptions) => Promise<LoadedProjectConfig>;
  readonly loadFunctionsManifest: (cwd: string) => Promise<FunctionsManifest>;
}

/**
 * Builds the Promise-based `@supabase/config/io` facade over a given platform
 * layer. `Layer`'s `ROut` is declared contravariant (`in ROut`), so a
 * platform layer providing a superset of `FileSystem | Path` (e.g.
 * `BunServices.layer` / `NodeServices.layer`) is assignable here.
 */
export function makeProjectConfigIo(
  platformLayer: Layer.Layer<FileSystem.FileSystem | Path.Path>,
): ProjectConfigIo {
  function buildRuntime() {
    return ManagedRuntime.make(
      Layer.mergeAll(platformLayer, projectConfigStoreLayer.pipe(Layer.provide(platformLayer))),
    );
  }

  // Lazily built once per module and never disposed — this facade is a
  // process-lifetime singleton, not a scoped resource, so there is no
  // natural point at which to call `runtime.dispose()`. `ManagedRuntime.make`
  // memoizes its build fiber, so a hypothetical failed build would replay its
  // failure on every later call — unreachable today because the
  // `FileSystem`/`Path` layers this facade is built from have `E = never`,
  // but worth knowing if that ever changes.
  let runtime: ReturnType<typeof buildRuntime> | undefined;

  function getRuntime() {
    runtime ??= buildRuntime();
    return runtime;
  }

  return {
    loadProjectConfig: async (cwd, options) =>
      getRuntime().runPromise(ProjectConfigStore.use((store) => store.load(cwd, options))),
    findProjectRootFor: async (cwd) => getRuntime().runPromise(findProjectRoot(cwd)),
    findProjectPathsFor: async (cwd) => getRuntime().runPromise(findProjectPaths(cwd)),
    loadProjectConfigFile: async (path) =>
      getRuntime().runPromise(ProjectConfigStore.use((store) => store.loadFile(path))),
    loadProjectEnvironmentFor: async (options) =>
      getRuntime().runPromise(
        loadProjectEnvironment({ ...options, baseEnv: options.baseEnv ?? process.env }),
      ),
    saveProjectConfig: async (options) =>
      getRuntime().runPromise(ProjectConfigStore.use((store) => store.save(options))),
    loadFunctionsManifest: async (cwd) => getRuntime().runPromise(inferFunctionsManifest({ cwd })),
  };
}
