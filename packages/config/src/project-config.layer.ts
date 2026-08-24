import { Effect, FileSystem, Layer, Path } from "effect";
import { loadProjectConfig, loadProjectConfigFile, saveProjectConfig } from "./io.ts";
import { ProjectConfigStore, ProjectConfigStoreError } from "./project-config.service.ts";

const makeProjectConfigStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const providePlatform = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  return ProjectConfigStore.of({
    load: (cwd, options) =>
      providePlatform(loadProjectConfig(cwd, options)).pipe(
        Effect.mapError((cause) => new ProjectConfigStoreError({ operation: "load", cause })),
      ),
    loadFile: (filePath) =>
      providePlatform(loadProjectConfigFile(filePath)).pipe(
        Effect.mapError((cause) => new ProjectConfigStoreError({ operation: "loadFile", cause })),
      ),
    save: (options) =>
      providePlatform(saveProjectConfig(options)).pipe(
        Effect.mapError((cause) => new ProjectConfigStoreError({ operation: "save", cause })),
      ),
  });
});

export const projectConfigStoreLayer = Layer.effect(ProjectConfigStore, makeProjectConfigStore);
