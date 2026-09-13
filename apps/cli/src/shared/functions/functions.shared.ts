import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { dockerfileServiceImageRaw } from "../services/dockerfile-images.ts";
import { imageTag, slimImageForCurrentPin } from "../services/slim-images.ts";

const functionSlugPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const invalidFunctionSlugDetail =
  "Invalid Function name. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens. (^[A-Za-z][A-Za-z0-9_-]*$)";

export function validateFunctionSlugMessage(slug: string): string | undefined {
  return functionSlugPattern.test(slug) ? undefined : invalidFunctionSlugDetail;
}

export const FUNCTIONS_PROJECT_REF_SAFE_FLAGS = ["project-ref"] as const;

// Order is rendered verbatim in the mutually-exclusive-flags error message.
export const FUNCTIONS_BUNDLER_MUTEX_GROUP = ["use-api", "use-docker", "legacy-bundle"] as const;

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
 * with no `v` prefix synthesized.
 */
export function edgeRuntimeImage(tag: string): string {
  if (tag === DENO1_EDGE_RUNTIME_VERSION) {
    return `supabase/edge-runtime:${DENO1_EDGE_RUNTIME_VERSION}`;
  }
  return slimImageForCurrentPin("edgeruntime", dockerfileServiceImageRaw("edgeruntime"), tag);
}

/**
 * Reads the `.temp/edge-runtime-version` pin file if present, falling back to
 * the Dockerfile-embedded tag. Shared by every `functions` command that
 * resolves a Docker edge-runtime image.
 */
export const resolveEdgeRuntimeVersionPin = Effect.fnUntraced(function* (supabaseDir: string) {
  return yield* Effect.tryPromise(() =>
    readFile(join(supabaseDir, ".temp", "edge-runtime-version"), "utf8"),
  ).pipe(
    Effect.map((version) => version.trim()),
    Effect.catch(() => Effect.succeed("")),
    Effect.map((version) => version || (imageTag(dockerfileServiceImageRaw("edgeruntime")) ?? "")),
  );
});
