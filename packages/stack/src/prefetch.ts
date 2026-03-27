import { Effect } from "effect";
import type { ChecksumMismatchError } from "./errors.ts";
import type { DockerPullError } from "./errors.ts";
import { type PreparedStackArtifacts, type StackPreparationInput } from "./StackPreparation.ts";
import { StackPreparation } from "./StackPreparation.ts";
import type { ServiceResolution } from "./resolve.ts";

export interface PrefetchOptions extends StackPreparationInput {}

export type PrefetchResult = Record<string, ServiceResolution>;

const toPrefetchResult = (artifacts: PreparedStackArtifacts): PrefetchResult =>
  artifacts.resolutions as PrefetchResult;

export const prefetch = (
  options?: PrefetchOptions,
): Effect.Effect<PrefetchResult, DockerPullError | ChecksumMismatchError, StackPreparation> =>
  Effect.gen(function* () {
    const preparation = yield* StackPreparation;
    return yield* preparation.prepare(options).pipe(Effect.map(toPrefetchResult));
  });
