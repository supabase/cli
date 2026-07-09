import { Effect } from "effect";
import {
  StackPreparation,
  type PreparedStackArtifacts,
  type StackPreparationError,
  type StackPreparationInput,
} from "./StackPreparation.ts";
import type { ServiceResolution } from "./resolve.ts";

export interface PrefetchOptions extends StackPreparationInput {}

export type PrefetchResult = Record<string, ServiceResolution>;

const toPrefetchResult = (artifacts: PreparedStackArtifacts): PrefetchResult =>
  artifacts.resolutions as PrefetchResult;

export const prefetch = (
  options?: PrefetchOptions,
): Effect.Effect<PrefetchResult, StackPreparationError, StackPreparation> =>
  Effect.gen(function* () {
    const preparation = yield* StackPreparation;
    return yield* preparation.prepare(options).pipe(Effect.map(toPrefetchResult));
  });
