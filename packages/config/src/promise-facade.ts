import type { FileSystem, Path } from "effect";
import { Layer, ManagedRuntime } from "effect";
import type {
  LoadedCliConfig,
  LoadCliConfigOptions,
  SaveCliConfigOptions,
} from "./config-document.ts";
import type { FunctionsManifest } from "./functions-manifest-model.ts";
import { inferFunctionsManifest } from "./functions-manifest.ts";
import type { CliProjectPaths } from "./paths.ts";
import type { LoadCliProjectEnvironmentOptions, CliProjectEnvironment } from "./project.ts";
import { loadCliProjectEnvironment } from "./project.ts";
import { findCliProjectPaths, findCliProjectRoot } from "./paths.ts";
import { cliConfigStoreLayer } from "./cli-config.layer.ts";
import { CliConfigStore } from "./cli-config.service.ts";

export interface CliConfigIo {
  readonly loadCliConfig: (
    cwd: string,
    options?: LoadCliConfigOptions,
  ) => Promise<LoadedCliConfig | null>;
  readonly findCliProjectRootFor: (cwd: string) => Promise<string | null>;
  readonly findCliProjectPathsFor: (cwd: string) => Promise<CliProjectPaths | null>;
  readonly loadCliConfigFile: (path: string) => Promise<LoadedCliConfig>;
  readonly loadCliProjectEnvironmentFor: (
    options: LoadCliProjectEnvironmentOptions,
  ) => Promise<CliProjectEnvironment | null>;
  readonly saveCliConfig: (options: SaveCliConfigOptions) => Promise<LoadedCliConfig>;
  readonly loadFunctionsManifest: (cwd: string) => Promise<FunctionsManifest>;
}

/**
 * Builds the Promise-based `@supabase/config/io` facade over a given platform
 * layer. `Layer`'s `ROut` is declared contravariant (`in ROut`), so a
 * platform layer providing a superset of `FileSystem | Path` (e.g.
 * `BunServices.layer` / `NodeServices.layer`) is assignable here.
 */
export function makeCliConfigIo(
  platformLayer: Layer.Layer<FileSystem.FileSystem | Path.Path>,
): CliConfigIo {
  function buildRuntime() {
    return ManagedRuntime.make(
      Layer.mergeAll(platformLayer, cliConfigStoreLayer.pipe(Layer.provide(platformLayer))),
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
    loadCliConfig: async (cwd, options) =>
      getRuntime().runPromise(CliConfigStore.use((store) => store.load(cwd, options))),
    findCliProjectRootFor: async (cwd) => getRuntime().runPromise(findCliProjectRoot(cwd)),
    findCliProjectPathsFor: async (cwd) => getRuntime().runPromise(findCliProjectPaths(cwd)),
    loadCliConfigFile: async (path) =>
      getRuntime().runPromise(CliConfigStore.use((store) => store.loadFile(path))),
    loadCliProjectEnvironmentFor: async (options) =>
      getRuntime().runPromise(
        loadCliProjectEnvironment({ ...options, baseEnv: options.baseEnv ?? process.env }),
      ),
    saveCliConfig: async (options) =>
      getRuntime().runPromise(CliConfigStore.use((store) => store.save(options))),
    loadFunctionsManifest: async (cwd) => getRuntime().runPromise(inferFunctionsManifest({ cwd })),
  };
}
