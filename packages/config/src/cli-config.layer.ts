import { Effect, FileSystem, Layer, Path } from "effect";
import { loadCliConfig, loadCliConfigFile, saveCliConfig } from "./io.ts";
import { CliConfigStore } from "./cli-config.service.ts";

const makeCliConfigStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const providePlatform = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  return CliConfigStore.of({
    load: (cwd, options) => providePlatform(loadCliConfig(cwd, options)),
    loadFile: (filePath) => providePlatform(loadCliConfigFile(filePath)),
    save: (options) => providePlatform(saveCliConfig(options)),
  });
});

export const cliConfigStoreLayer = Layer.effect(CliConfigStore, makeCliConfigStore);
