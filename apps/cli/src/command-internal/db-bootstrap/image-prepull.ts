/**
 * Resolves and pulls every image `supabase start` needs into the local Docker cache before any
 * container is created, using the same multi-registry fallback as the per-container start path.
 * This is the only pre-pull step; every image must resolve through it before a container starts.
 */

import { Data, Effect, Result } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import { makeDockerImageResolver } from "../docker-image-resolve.ts";
import { SUGGEST_DOCKER_INSTALL, isDockerDaemonUnreachable } from "../docker-suggest.ts";

type Spawner = ChildProcessSpawner["Service"];

/**
 * One or more images failed to resolve/pull from every registry candidate. The message
 * aggregates every failed image's own error rather than surfacing only the first failure.
 */
export class ImagePrepullError extends Data.TaggedError("ImagePrepullError")<{
  readonly message: string;
  readonly reason: "docker_daemon" | "registry_pull" | "image_inspect";
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    switch (this.reason) {
      case "docker_daemon":
        return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
      case "registry_pull":
        return { ...actionability.externalNetwork, fingerprint_suffix: "registry_pull" };
      default:
        return { ...actionability.invalidConfig, fingerprint_suffix: "image_inspect" };
    }
  }
}

/**
 * Resolves every image in `images` concurrently through the shared registry-fallback resolver.
 *
 * Returns a map from each original image reference to the resolved image URL callers must use
 * to reference that image afterward — re-resolving the same image could land on a different
 * registry candidate on a second call. `images` is deduped internally.
 */
export function ensureImagesCached(
  spawner: Spawner,
  images: ReadonlyArray<string>,
  projectEnvValues?: Readonly<Record<string, string>>,
): Effect.Effect<ReadonlyMap<string, string>, ImagePrepullError> {
  const uniqueImages = [...new Set(images)];
  const resolveImage = makeDockerImageResolver(spawner, projectEnvValues);

  return Effect.gen(function* () {
    const results = yield* Effect.all(
      uniqueImages.map((image) => resolveImage(image).pipe(Effect.result)),
      { concurrency: "unbounded" },
    );

    const resolved = new Map<string, string>();
    const failures: Array<string> = [];
    let failureReason: ImagePrepullError["reason"] = "image_inspect";
    for (const [index, image] of uniqueImages.entries()) {
      const result = results[index];
      if (result === undefined || Result.isFailure(result)) {
        failures.push(result === undefined ? `${image}: unknown error` : result.failure.message);
        if (result !== undefined) {
          const failure = result.failure;
          if (failure.reason === "spawn" || failure.daemonDown) {
            failureReason = "docker_daemon";
          } else if (failure.reason === "pull" && failureReason !== "docker_daemon") {
            failureReason = "registry_pull";
          }
        }
        continue;
      }
      resolved.set(image, result.success);
    }

    if (failures.length > 0) {
      // The install hint is appended once after every resolve finishes, rather than emitted
      // from inside the resolver, to avoid duplicate hints from concurrent failures.
      const hint = failures.some(isDockerDaemonUnreachable) ? `\n\n${SUGGEST_DOCKER_INSTALL}` : "";
      return yield* Effect.fail(
        new ImagePrepullError({
          message: `${failures.join("\n")}${hint}`,
          reason: failureReason,
        }),
      );
    }

    return resolved;
  });
}
