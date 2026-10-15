import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { type LegacyStateFile, legacyProjectStatePaths } from "./legacy-project-state.paths.ts";
import { LegacyProjectState, ProjectRefReadError } from "./legacy-project-state.service.ts";

/**
 * Reads the linked project ref, `None` when the file is absent or blank. Any other read error
 * (a directory, permission denied) fails instead of reading as unlinked.
 */
export const readLegacyProjectRef = (
  fs: FileSystem.FileSystem,
  path: Pick<Path.Path, "join">,
  workdir: string,
): Effect.Effect<Option.Option<string>, ProjectRefReadError> =>
  Effect.gen(function* () {
    const content = yield* fs
      .readFileString(legacyProjectStatePaths(path, workdir).projectRef)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed("")
            : Effect.fail(
                new ProjectRefReadError({
                  message: `failed to load project ref: ${error.message}`,
                }),
              ),
        ),
      );
    const trimmed = content.trim();
    return trimmed.length === 0 ? Option.none<string>() : Option.some(trimmed);
  });

const makeLegacyProjectState = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = (workdir: string) => legacyProjectStatePaths(path, workdir);

  const exists = Effect.fn("LegacyProjectState.exists")(function* (
    workdir: string,
    file: LegacyStateFile,
  ) {
    yield* Effect.annotateCurrentSpan("legacy_state.file", file);
    return yield* fs.exists(paths(workdir)[file]);
  });

  const read = Effect.fn("LegacyProjectState.read")(function* (
    workdir: string,
    file: LegacyStateFile,
  ) {
    yield* Effect.annotateCurrentSpan("legacy_state.file", file);
    return yield* fs.readFileString(paths(workdir)[file]);
  });

  const write = Effect.fn("LegacyProjectState.write")(function* (
    workdir: string,
    file: LegacyStateFile,
    content: string,
  ) {
    yield* Effect.annotateCurrentSpan("legacy_state.file", file);
    const filePath = paths(workdir)[file];
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, content);
  });

  const remove = Effect.fn("LegacyProjectState.remove")(function* (
    workdir: string,
    file: LegacyStateFile,
  ) {
    yield* Effect.annotateCurrentSpan("legacy_state.file", file);
    yield* fs.remove(paths(workdir)[file], { recursive: true, force: true });
  });

  const removeAll = Effect.fn("LegacyProjectState.removeAll")(function* (workdir: string) {
    yield* fs.remove(paths(workdir).tempDir, { recursive: true, force: true });
  });

  const readProjectRef = (workdir: string) => readLegacyProjectRef(fs, path, workdir);

  return LegacyProjectState.of({
    paths,
    exists,
    read,
    write,
    remove,
    removeAll,
    readProjectRef,
  });
});

/** Needs only `FileSystem` and `Path`, so the root provides it to every command. */
export const legacyProjectStateLayer = Layer.effect(LegacyProjectState, makeLegacyProjectState);
