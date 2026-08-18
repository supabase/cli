import { Effect } from "effect";
import type { StackPreparationError } from "./StackPreparation.ts";
import {
  type PreparedStackArtifacts,
  type ServiceResolution,
  type StackPreparationInput,
} from "./StackPreparation.ts";
import { StackPreparation } from "./StackPreparation.ts";
import type { ServiceName } from "./ServiceName.ts";

export interface PrefetchOptions extends Omit<StackPreparationInput, "containerRuntime" | "mode"> {
  readonly mode?: StackPreparationInput["mode"];
}

interface ResolvedPrefetchOptions extends PrefetchOptions {
  readonly containerRuntime?: import("./ContainerRuntime.ts").ContainerRuntime;
}

export type PrefetchResult = Partial<Record<ServiceName, ServiceResolution>>;

const toPrefetchResult = (artifacts: PreparedStackArtifacts): PrefetchResult =>
  artifacts.resolutions;

export const prefetch = (
  options?: ResolvedPrefetchOptions,
): Effect.Effect<PrefetchResult, StackPreparationError, StackPreparation> =>
  Effect.gen(function* () {
    const preparation = yield* StackPreparation;
    return yield* preparation
      .prepare({ mode: options?.mode ?? "native", ...options })
      .pipe(Effect.map(toPrefetchResult));
  });
