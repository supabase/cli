import { Effect, FileSystem, Layer, Path } from "effect";
import { loadProjectConfig, loadProjectConfigFile, saveProjectConfig } from "./io.ts";
import { ProjectConfigStore } from "./project-config.service.ts";

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
    load: (cwd) => providePlatform(loadProjectConfig(cwd)),
    loadFile: (filePath) => providePlatform(loadProjectConfigFile(filePath)),
    save: (options) => providePlatform(saveProjectConfig(options)),
  });
});

export const projectConfigStoreLayer = Layer.effect(ProjectConfigStore, makeProjectConfigStore);
