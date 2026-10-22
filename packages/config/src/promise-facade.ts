import type { FileSystem, Path } from "effect";
import { Effect, Layer, ManagedRuntime } from "effect";
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

/**
 * A rejection from `loadCliConfig`, `loadCliConfigFile`, or `saveCliConfig` carries one of
 * `CliConfigParseError`, `DuplicateRemoteProjectIdError`, `InvalidRemoteProjectIdError`,
 * `CliProjectEnvParseError`, or a `PlatformError` for a host/OS failure — check with
 * `instanceof`.
 */
export interface CliConfigIo {
  readonly loadCliConfig: (
    cwd: string,
    options?: LoadCliConfigOptions,
  ) => Promise<LoadedCliConfig | null>;
  readonly findCliProjectRoot: (cwd: string) => Promise<string | null>;
  readonly findCliProjectPaths: (cwd: string) => Promise<CliProjectPaths | null>;
  readonly loadCliConfigFile: (path: string) => Promise<LoadedCliConfig>;
  readonly loadCliProjectEnvironment: (
    options: LoadCliProjectEnvironmentOptions,
  ) => Promise<CliProjectEnvironment | null>;
  readonly saveCliConfig: (options: SaveCliConfigOptions) => Promise<LoadedCliConfig>;
  readonly inferFunctionsManifest: (cwd: string) => Promise<FunctionsManifest>;
}

/**
 * Builds the Promise-based `@supabase/config/io` facade over a given platform layer.
 * Accepts any layer providing a superset of `FileSystem | Path` (e.g. `BunServices.layer`
 * or `NodeServices.layer`).
 */
export function makeCliConfigIo(
  platformLayer: Layer.Layer<FileSystem.FileSystem | Path.Path>,
): CliConfigIo {
  function buildRuntime() {
    return ManagedRuntime.make(
      Layer.mergeAll(platformLayer, cliConfigStoreLayer.pipe(Layer.provide(platformLayer))),
    );
  }

  // Lazily built once and never disposed: this facade is a process-lifetime singleton, not
  // a scoped resource. `ManagedRuntime.make` memoizes its build fiber, so a failed build
  // would replay that failure on every later call.
  let runtime: ReturnType<typeof buildRuntime> | undefined;

  function getRuntime() {
    runtime ??= buildRuntime();
    return runtime;
  }

  /* Never throws synchronously: a throw while building the program rejects like any failure. */
  function run<A, E>(
    program: () => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | CliConfigStore>,
  ) {
    return getRuntime().runPromise(Effect.suspend(program));
  }

  return {
    loadCliConfig: (cwd, options) =>
      run(() => CliConfigStore.use((store) => store.load(cwd, options))),
    findCliProjectRoot: (cwd) => run(() => findCliProjectRoot(cwd)),
    findCliProjectPaths: (cwd) => run(() => findCliProjectPaths(cwd)),
    loadCliConfigFile: (path) => run(() => CliConfigStore.use((store) => store.loadFile(path))),
    loadCliProjectEnvironment: (options) =>
      run(() => loadCliProjectEnvironment({ ...options, baseEnv: options.baseEnv ?? process.env })),
    saveCliConfig: (options) => run(() => CliConfigStore.use((store) => store.save(options))),
    inferFunctionsManifest: (cwd) => run(() => inferFunctionsManifest({ cwd })),
  };
}
