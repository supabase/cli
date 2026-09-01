import { Effect } from "effect";
import type { ContainerRuntime } from "./ContainerRuntime.ts";
import type { StackPreparationError } from "./StackPreparation.ts";
import {
  type PreparedStackArtifacts,
  type ServiceResolution,
  type StackPreparationInput,
} from "./StackPreparation.ts";
import { StackPreparation } from "./StackPreparation.ts";
import type { ServiceName } from "./ServiceName.ts";

export interface PrefetchOptions {
  /** Root directory used for native binary cache entries. */
  readonly cacheRoot?: string;
  readonly versions?: StackPreparationInput["versions"];
  readonly services?: StackPreparationInput["services"];
  readonly enabledServices?: StackPreparationInput["enabledServices"];
  readonly mode?: "native" | "docker";
}

export type PrefetchEffectOptions = Omit<PrefetchOptions, "mode" | "cacheRoot"> &
  (
    | { readonly mode?: "native"; readonly containerRuntime?: never }
    | { readonly mode: "docker"; readonly containerRuntime: ContainerRuntime }
  );

export type PrefetchResult = Partial<Record<ServiceName, ServiceResolution>>;

const toPrefetchResult = (artifacts: PreparedStackArtifacts): PrefetchResult =>
  artifacts.resolutions;

export const prefetch = (
  options?: PrefetchEffectOptions,
): Effect.Effect<PrefetchResult, StackPreparationError, StackPreparation> =>
  Effect.gen(function* () {
    const preparation = yield* StackPreparation;
    const input: StackPreparationInput =
      options?.mode === "docker" ? options : { ...options, mode: "native" };
    return yield* preparation.prepare(input).pipe(Effect.map(toPrefetchResult));
  });
