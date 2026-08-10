import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { dockerfileServiceImage } from "../services/dockerfile-images.ts";

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

// Go: `Images.EdgeRuntime`'s default tag is baked into the binary via the
// embedded Dockerfile (`legacy-edge-runtime-image.ts` reads the same source)
// — sourced from there rather than `@supabase/stack`'s independently-
// maintained catalog, so a Dockerfile pin bump can never drift from what the
// `functions` Docker paths resolve.
const DEFAULT_EDGE_RUNTIME_TAG = dockerfileServiceImage("edgeruntime").split(":")[1] ?? "";

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
    Effect.map((version) => version || DEFAULT_EDGE_RUNTIME_TAG),
  );
});
