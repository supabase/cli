import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import {
  dockerfileServiceImage,
  dockerfileServiceImageRaw,
} from "../services/dockerfile-images.ts";
import { slimImageForCurrentPin } from "../services/slim-images.ts";

const functionSlugPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const invalidFunctionSlugDetail =
  "Invalid Function name. Must start with at least one letter, and only include alphanumeric characters, underscores, and hyphens. (^[A-Za-z][A-Za-z0-9_-]*$)";

export function validateFunctionSlugMessage(slug: string): string | undefined {
  return functionSlugPattern.test(slug) ? undefined : invalidFunctionSlugDetail;
}

// Go marks `--project-ref` telemetry-safe on `functionsListCmd`, `functionsDeleteCmd`,
// `functionsDeployCmd`, and `functionsDownloadCmd`
// (`cmd/functions.go:151,153,165,178`).
export const FUNCTIONS_PROJECT_REF_SAFE_FLAGS = ["project-ref"] as const;

// Registration order matches Go's `functionsDeployCmd`/`functionsDownloadCmd`
// `MarkFlagsMutuallyExclusive("use-api", "use-docker", "legacy-bundle")`
// (`cmd/functions.go:158,182`).
export const FUNCTIONS_BUNDLER_MUTEX_GROUP = ["use-api", "use-docker", "legacy-bundle"] as const;

// Go: `Images.EdgeRuntime` is baked into the binary via the embedded
// Dockerfile (`pkg/config/constants.go:40-58`; `legacy-edge-runtime-image.ts`
// reads the same source) — sourced from there rather than `@supabase/stack`'s
// independently-maintained catalog, so a Dockerfile pin bump can never drift
// from what the `functions` Docker paths resolve.
// Read per call, not captured at import time, so `SUPABASE_USE_SLIM_IMAGES` is
// observed by every resolution (and by tests that stub the env).
const defaultEdgeRuntimeImage = () => dockerfileServiceImage("edgeruntime");

// Go's `deno1` image tag (`pkg/config/constants.go:15`,
// `supabase/edge-runtime:v1.68.4`) — a full tag, since tags flow verbatim
// into `edgeRuntimeImage` with no `v` synthesis. Shared with
// `functions-docker.ts`'s `resolveEdgeRuntimeVersion`, which selects it.
export const DENO1_EDGE_RUNTIME_VERSION = "v1.68.4";

/**
 * Go: `replaceImageTag(Images.EdgeRuntime, tag)` (`pkg/config/utils.go:81-84`)
 * — everything after the image's first `:` is replaced with `tag` VERBATIM,
 * no `v` synthesis. A bare pin like `latest` or `9.9.9` therefore produces
 * `supabase/edge-runtime:latest`/`:9.9.9`, exactly as Go does (an earlier
 * revision `v`-prefixed bare pins here, which broke pins that work in Go and
 * made this path disagree with `legacy-edge-runtime-image.ts`'s faithful
 * `replaceImageTag` port reading the SAME pin file — review round on
 * CLI-1963). Both non-pin sources are already full tags: the Dockerfile
 * default above and `resolveEdgeRuntimeVersion`'s deno-1 constant.
 * Single home for the repository too — only the tag half is parameterized,
 * so a `supabase/edge-runtime` rename in the Dockerfile propagates whole.
 *
 * `deno_version = 1` is a locked docker.io-only exception (no slim build):
 * the "tag" it selects is really a whole different image squeezed through
 * this tag-shaped API, so it bypasses the (possibly slim-rewritten) default
 * base entirely and returns the full docker.io ref. Flag-off this is
 * byte-identical to the general path, since the default base is already
 * docker.io then. The tag check deliberately also catches an explicit
 * `.temp/edge-runtime-version` pin of this exact tag under the slim flag:
 * no slim build of it exists either, so docker.io is the only resolvable
 * image for that tag regardless of WHY it was selected — a separate
 * deno_version signal would change nothing observable.
 */
export function edgeRuntimeImage(tag: string): string {
  if (tag === DENO1_EDGE_RUNTIME_VERSION) {
    return `supabase/edge-runtime:${DENO1_EDGE_RUNTIME_VERSION}`;
  }
  return slimImageForCurrentPin("edgeruntime", dockerfileServiceImageRaw("edgeruntime"), tag);
}

/**
 * Go: `Config.EdgeRuntime.Image` reflects `supabase/.temp/edge-runtime-version`
 * when present (`pkg/config/config.go:847-849`) — shared by every `functions`
 * command that resolves a Docker edge-runtime image: `deploy`/`download` in
 * both shells, plus `serve` (legacy-only — `next` has no native `serve`).
 * Single home for the file-read rather than several copies of the same
 * `readFile` -> `trim` -> fallback pipeline.
 */
export const resolveEdgeRuntimeVersionPin = Effect.fnUntraced(function* (supabaseDir: string) {
  return yield* Effect.tryPromise(() =>
    readFile(join(supabaseDir, ".temp", "edge-runtime-version"), "utf8"),
  ).pipe(
    Effect.map((version) => version.trim()),
    Effect.catch(() => Effect.succeed("")),
    Effect.map((version) => version || (defaultEdgeRuntimeImage().split(":")[1] ?? "")),
  );
});
