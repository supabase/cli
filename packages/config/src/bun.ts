import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime } from "effect";
import type {
  LoadedProjectConfig,
  LoadProjectConfigOptions,
  SaveProjectConfigOptions,
} from "./io.ts";
import type { ProjectPaths } from "./paths.ts";
import type { LoadProjectEnvironmentOptions, ProjectEnvironment } from "./project.ts";
import { inferFunctionsManifest, type FunctionsManifest } from "./functions-manifest.ts";
import { loadProjectEnvironment } from "./project.ts";
import { findProjectPaths, findProjectRoot } from "./paths.ts";
import { projectConfigStoreLayer } from "./project-config.layer.ts";
import { ProjectConfigStore } from "./project-config.service.ts";

function makeRuntime() {
  return ManagedRuntime.make(
    Layer.mergeAll(
      BunServices.layer,
      projectConfigStoreLayer.pipe(Layer.provide(BunServices.layer)),
    ),
  );
}

export function loadProjectConfig(
  cwd: string,
  options?: LoadProjectConfigOptions,
): Promise<LoadedProjectConfig | null> {
  const runtime = makeRuntime();
  return runtime.runPromise(ProjectConfigStore.use((store) => store.load(cwd, options)));
}

export function findProjectRootFor(cwd: string): Promise<string | null> {
  const runtime = makeRuntime();
  return runtime.runPromise(findProjectRoot(cwd));
}

export function findProjectPathsFor(cwd: string): Promise<ProjectPaths | null> {
  const runtime = makeRuntime();
  return runtime.runPromise(findProjectPaths(cwd));
}

export function loadProjectConfigFile(path: string): Promise<LoadedProjectConfig> {
  const runtime = makeRuntime();
  return runtime.runPromise(ProjectConfigStore.use((store) => store.loadFile(path)));
}

export function loadProjectEnvironmentFor(
  options: LoadProjectEnvironmentOptions,
): Promise<ProjectEnvironment | null> {
  const runtime = makeRuntime();
  return runtime.runPromise(
    loadProjectEnvironment({ ...options, baseEnv: options.baseEnv ?? process.env }),
  );
}

export function saveProjectConfig(options: SaveProjectConfigOptions): Promise<LoadedProjectConfig> {
  const runtime = makeRuntime();
  return runtime.runPromise(ProjectConfigStore.use((store) => store.save(options)));
}

export function loadFunctionsManifest(cwd: string): Promise<FunctionsManifest> {
  const runtime = makeRuntime();
  return runtime.runPromise(
    Effect.gen(function* () {
      const projectEnv = yield* loadProjectEnvironment({ cwd, baseEnv: process.env });
      return yield* inferFunctionsManifest({
        cwd,
        ...(projectEnv === null ? {} : { projectEnv }),
      });
    }),
  );
}
