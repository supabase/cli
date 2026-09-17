import { Effect, Result } from "effect";
import { slimImagePullCandidates } from "../model/SlimArtifactMirrors.ts";
import type { ContainerEngine, ContainerEngineFailure } from "./ContainerEngine.ts";

export interface ResolvedContainerImage {
  readonly image: string;
  readonly outcome: "cached" | "pulled";
}

/**
 * Inspects every slim candidate locally, then pulls in order. Engine failures
 * on inspect (daemon down) fail immediately; pull failures fall through.
 */
export const resolveAvailableContainerImage = (
  engine: Pick<ContainerEngine, "inspectImage" | "pullImage">,
  image: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  onPull?: () => void,
): Effect.Effect<ResolvedContainerImage, ContainerEngineFailure> =>
  Effect.gen(function* () {
    const override = env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
    const candidates = slimImagePullCandidates(image, {
      env,
      ...(override === undefined || override.trim() === "" ? {} : { registryOverride: override }),
    });
    for (const candidate of candidates) {
      const inspected = yield* engine.inspectImage(candidate);
      if (inspected.present) return { image: candidate, outcome: "cached" };
    }
    yield* Effect.sync(() => onPull?.());
    let lastError: ContainerEngineFailure | undefined;
    for (const candidate of candidates) {
      const pulled = yield* Effect.result(engine.pullImage(candidate));
      if (Result.isSuccess(pulled)) return { image: candidate, outcome: "pulled" };
      lastError = pulled.failure;
    }
    if (lastError === undefined)
      return yield* engine
        .inspectImage(image)
        .pipe(Effect.as({ image, outcome: "cached" as const }));
    return yield* lastError;
  });
