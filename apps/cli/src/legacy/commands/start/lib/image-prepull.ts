/**
 * Port of Go's `ensureImagesCached` (`apps/cli-go/internal/start/start.go:225-262`):
 * guarantees every image `supabase start` needs is resolved/pulled into the
 * local Docker cache BEFORE any container is created, using the same
 * multi-registry fallback as the per-container start path
 * (`legacyMakeDockerImageResolver`).
 *
 * Go's caller (`internal/start/start.go:264-291`, `run`) also runs a
 * best-effort `docker-compose`-based pre-pull first
 * (`pullImagesUsingCompose`) and treats `ensureImagesCached` as the hard-failing
 * backstop that catches whatever the compose pre-pull's `IgnoreFailures` step
 * skipped. This port does not implement docker-compose integration anywhere
 * (an intentional architecture decision for this port), so
 * {@link legacyEnsureImagesCached} is the ONLY image pre-pull step here, not a
 * backstop for a separate best-effort pass — every image must resolve through
 * this call before any container starts.
 */

import { Data, Effect, Result } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { legacyMakeDockerImageResolver } from "../../../shared/legacy-docker-image-resolve.ts";
import {
  LEGACY_SUGGEST_DOCKER_INSTALL,
  legacyIsDockerDaemonUnreachable,
} from "../../../shared/legacy-docker-suggest.ts";

type Spawner = ChildProcessSpawner["Service"];

/**
 * One or more images failed to resolve/pull from every registry candidate.
 * Mirrors Go's `errors.Join(result...)` (`start.go:257`): the message
 * aggregates every failed image's own error rather than surfacing only the
 * first failure, so a caller can see every broken image in one report.
 */
export class LegacyImagePrepullError extends Data.TaggedError("LegacyImagePrepullError")<{
  readonly message: string;
}> {}

/**
 * Resolves every image in `images` concurrently (Go's `utils.WaitAll` —
 * unbounded goroutines) via the shared registry-fallback resolver, and returns
 * a map from the ORIGINAL image reference to the resolved image URL a caller
 * must use to reference that image afterward (e.g. as
 * `LegacyStartContainerSpec.image`) — resolving the same image twice would be
 * wasteful and could, in theory, land on a different registry candidate on a
 * second, independent call.
 *
 * `images` is deduped here (Go's `seen := map[string]struct{}{}`,
 * `start.go:238-249`) — callers are not expected to have already deduped their
 * service image list.
 */
export function legacyEnsureImagesCached(
  spawner: Spawner,
  images: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, string>, LegacyImagePrepullError> {
  const uniqueImages = [...new Set(images)];
  const resolveImage = legacyMakeDockerImageResolver(spawner);

  return Effect.gen(function* () {
    const results = yield* Effect.all(
      uniqueImages.map((image) => resolveImage(image).pipe(Effect.result)),
      { concurrency: "unbounded" },
    );

    const resolved = new Map<string, string>();
    const failures: Array<string> = [];
    for (const [index, image] of uniqueImages.entries()) {
      const result = results[index];
      if (result === undefined || Result.isFailure(result)) {
        failures.push(result === undefined ? `${image}: unknown error` : result.failure.message);
        continue;
      }
      resolved.set(image, result.success);
    }

    if (failures.length > 0) {
      // Go sets the install hint once, sequentially, after the concurrent
      // resolve finishes (`SuggestDockerInstallIfConnectionFailed`,
      // `start.go:254-259`) rather than from inside the resolver itself, where
      // concurrent goroutines would race on the shared `CmdSuggestion` global.
      // There is no such global here, so the hint is appended directly onto
      // the joined message instead.
      const hint = failures.some(legacyIsDockerDaemonUnreachable)
        ? `\n\n${LEGACY_SUGGEST_DOCKER_INSTALL}`
        : "";
      return yield* Effect.fail(
        new LegacyImagePrepullError({ message: `${failures.join("\n")}${hint}` }),
      );
    }

    return resolved;
  });
}
