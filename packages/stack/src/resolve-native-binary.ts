import { Effect, FileSystem, Path } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { BinaryResolver, type BinarySpec } from "./BinaryResolver.ts";
import type { BinaryNotFoundError, ChecksumMismatchError, DownloadError } from "./errors.ts";

export const resolveNativeBinary = (
  cacheRoot: string,
  spec: BinarySpec,
): Effect.Effect<
  string,
  BinaryNotFoundError | DownloadError | ChecksumMismatchError,
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const resolver = yield* BinaryResolver;
    return yield* resolver.resolve(spec);
  }).pipe(Effect.provide(BinaryResolver.make(cacheRoot)));
