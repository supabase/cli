import { NodeServices } from "@effect/platform-node";
import { Layer, ManagedRuntime } from "effect";
import type { LoadedProjectConfig, SaveProjectConfigOptions } from "./io.ts";
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
      NodeServices.layer,
      projectConfigStoreLayer.pipe(Layer.provide(NodeServices.layer)),
    ),
  );
}

export async function loadProjectConfig(cwd: string): Promise<LoadedProjectConfig | null> {
  const runtime = makeRuntime();
  return runtime.runPromise(ProjectConfigStore.use((store) => store.load(cwd)));
}

export async function findProjectRootFor(cwd: string): Promise<string | null> {
  const runtime = makeRuntime();
  return runtime.runPromise(findProjectRoot(cwd));
}

export async function findProjectPathsFor(cwd: string): Promise<ProjectPaths | null> {
  const runtime = makeRuntime();
  return runtime.runPromise(findProjectPaths(cwd));
}

export async function loadProjectConfigFile(path: string): Promise<LoadedProjectConfig> {
  const runtime = makeRuntime();
  return runtime.runPromise(ProjectConfigStore.use((store) => store.loadFile(path)));
}

export async function loadProjectEnvironmentFor(
  options: LoadProjectEnvironmentOptions,
): Promise<ProjectEnvironment | null> {
  const runtime = makeRuntime();
  return runtime.runPromise(
    loadProjectEnvironment({ ...options, baseEnv: options.baseEnv ?? process.env }),
  );
}

export async function saveProjectConfig(
  options: SaveProjectConfigOptions,
): Promise<LoadedProjectConfig> {
  const runtime = makeRuntime();
  return runtime.runPromise(ProjectConfigStore.use((store) => store.save(options)));
}

export async function loadFunctionsManifest(cwd: string): Promise<FunctionsManifest> {
  const runtime = makeRuntime();
  return runtime.runPromise(inferFunctionsManifest({ cwd }));
}
