import { legacyProjectStatePaths } from "../config/legacy-project-state.paths.ts";
import { Effect, FileSystem, Option, Path } from "effect";
import { usesStackState } from "../../command-internal/stack-backend.ts";
import { readLockedPins } from "../../command-internal/stack-lock.ts";
import { dockerfileServiceImageRaw } from "../services/dockerfile-images.ts";
import {
  imageTag,
  isSlimImageRef,
  slimImageForCurrentPin,
  slimImagesEnabled,
} from "../services/slim-images.ts";

const functionSlugPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const invalidFunctionSlugDetail =
  "Invalid Function name. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens. (^[A-Za-z][A-Za-z0-9_-]*$)";

export function validateFunctionSlugMessage(slug: string): string | undefined {
  return functionSlugPattern.test(slug) ? undefined : invalidFunctionSlugDetail;
}

// Order is rendered verbatim in the mutually-exclusive-flags error message.
export const FUNCTIONS_DEPLOY_BUNDLER_MUTEX_GROUP = [
  "use-api",
  "use-docker",
  "legacy-bundle",
] as const;

// Order is rendered verbatim in the mutually-exclusive-flags error message. `legacy-bundle` is
// a removed, tombstoned flag on `functions download` (see `removedFlag`), rejected
// unconditionally before this group is ever checked, so it is not a member here.
export const FUNCTIONS_DOWNLOAD_BUNDLER_MUTEX_GROUP = ["use-api", "use-docker"] as const;

/**
 * Full deno-1 edge-runtime image tag, resolved from the embedded Dockerfile
 * pin (not `@supabase/stack`'s catalog) so it can't drift from what the
 * `functions` Docker paths pull. Shared with `functions-docker.ts`'s
 * `resolveEdgeRuntimeVersion`.
 */
export const DENO1_EDGE_RUNTIME_VERSION = "v1.68.4";

/**
 * Resolves the edge-runtime image for `tag`. The deno-1 pin always resolves
 * to the full docker.io image (no slim build exists for it); every other tag
 * is substituted verbatim into the (possibly slim-rewritten) default image,
 * with no `v` prefix synthesized. A slim image ref (the locked pin's own image) is used as is.
 */
export function edgeRuntimeImage(tag: string, slim: boolean): string {
  if (tag === DENO1_EDGE_RUNTIME_VERSION) {
    return `supabase/edge-runtime:${DENO1_EDGE_RUNTIME_VERSION}`;
  }
  if (slim && isSlimImageRef(tag)) {
    return tag;
  }
  return slimImageForCurrentPin("edgeruntime", dockerfileServiceImageRaw("edgeruntime"), tag, slim);
}

/**
 * The edge-runtime tag every `functions` command that resolves a Docker edge-runtime image uses.
 * Stack state mode takes the tag from the locked Functions pin without loading config or checking
 * the lock for staleness, since these commands never run the local stack, or the pin's own slim
 * image ref when slim images are enabled; legacy mode reads `.temp/edge-runtime-version`. Either
 * falls back to the Dockerfile-embedded tag.
 */
export const resolveEdgeRuntimeVersionPin = Effect.fn("Functions.resolveEdgeRuntimeVersionPin")(
  function* (workdir: string) {
    const bundledTag = imageTag(dockerfileServiceImageRaw("edgeruntime")) ?? "";
    if (yield* usesStackState) {
      const locked = yield* readLockedPins(workdir);
      const slim = yield* slimImagesEnabled;
      return Option.match(locked, {
        onNone: () => bundledTag,
        onSome: ({ functions }) =>
          slim ? functions.image : (imageTag(functions.upstreamImage) ?? bundledTag),
      });
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(legacyProjectStatePaths(path, workdir).edgeRuntimeVersion).pipe(
      Effect.map((version) => version.trim()),
      Effect.orElseSucceed(() => ""),
      Effect.map((version) => version || bundledTag),
    );
  },
);
