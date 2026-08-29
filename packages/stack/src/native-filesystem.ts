import { Effect, FileSystem } from "effect";
import { StackBuildError } from "./errors.ts";

/** Create a private native runtime directory, preserving its typed build error. */
export const prepareNativeDirectory = (
  path: string,
  detail: string,
): Effect.Effect<void, StackBuildError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .makeDirectory(path, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError((cause) => new StackBuildError({ detail, cause })));
  });

type WriteFileOptions = NonNullable<Parameters<FileSystem.FileSystem["writeFileString"]>[2]>;

/** Write a private native text file, preserving its typed build error. */
export const writeNativeFile = (
  path: string,
  content: string,
  detail: string,
  options?: WriteFileOptions,
): Effect.Effect<void, StackBuildError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .writeFileString(path, content, options)
      .pipe(Effect.mapError((cause) => new StackBuildError({ detail, cause })));
  });
