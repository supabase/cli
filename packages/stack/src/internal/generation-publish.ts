import { Effect, type FileSystem, type Path, type PlatformError } from "effect";

export interface GenerationFile {
  readonly name: string;
  readonly content: string;
  readonly mode: number;
}

let counter = 0;

/**
 * Publishes `files` together as `root/name` by renaming one staged directory into place, so readers
 * never see a partial generation. A rename can't replace a non-empty directory, so a collision with
 * an already-complete generation (same content-derived name) is success.
 */
export const publishGeneration = Effect.fn("Internal.publishGeneration")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  name: string,
  files: ReadonlyArray<GenerationFile>,
) {
  const generation = path.join(root, name);
  const isComplete = (directory: string): Effect.Effect<boolean, PlatformError.PlatformError> =>
    Effect.forEach(files, (file) => fs.exists(path.join(directory, file.name))).pipe(
      Effect.map((results) => results.every(Boolean)),
    );
  if (yield* isComplete(generation)) return generation;
  yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
  const stage = path.join(root, `.${name}.${process.pid}-${++counter}.tmp`);
  // Uninterruptible: an abandoned in-flight rename could otherwise publish a stage that cleanup has
  // already partly removed.
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(stage, { recursive: true, mode: 0o700 });
    for (const file of files)
      yield* fs.writeFileString(path.join(stage, file.name), file.content, { mode: file.mode });
    yield* fs.rename(stage, generation).pipe(
      Effect.catch((cause) =>
        isComplete(generation).pipe(
          Effect.orElseSucceed(() => false),
          Effect.flatMap((complete) => (complete ? Effect.void : Effect.fail(cause))),
        ),
      ),
    );
  }).pipe(
    Effect.ensuring(
      fs
        .remove(stage, { recursive: true, force: true })
        .pipe(Effect.catchTag("PlatformError", () => Effect.void)),
    ),
    Effect.uninterruptible,
  );
  return generation;
});
