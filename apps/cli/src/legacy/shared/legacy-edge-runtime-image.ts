import { Effect, type FileSystem, type Path } from "effect";

/**
 * Resolves the edge-runtime Docker image the way Go's `config.Load` does
 * (`apps/cli-go/pkg/config/config.go:445,682-683,999-1007`), for the
 * declarative pg-delta scripts that run inside the edge-runtime container.
 *
 * The default tag is baked into the Go binary via the embedded Dockerfile
 * (`FROM supabase/edge-runtime:v1.74.1 AS edgeruntime`), mirrored here as a
 * constant. A pinned tag in `supabase/.temp/edge-runtime-version` overrides it
 * (written by `supabase start`). `edge_runtime.deno_version = 1` selects the
 * legacy `deno1` image instead (default `deno_version = 2` keeps v1.74.1).
 */

// `FROM supabase/edge-runtime:v1.74.1 AS edgeruntime` (embedded Dockerfile).
const LEGACY_EDGE_RUNTIME_IMAGE = "supabase/edge-runtime:v1.74.1";
// `deno1` (`pkg/config/constants.go:15`) — used when `deno_version = 1`.
const LEGACY_EDGE_RUNTIME_DENO1_IMAGE = "supabase/edge-runtime:v1.68.4";

/** `pkg/config/utils.go:81` — replace everything after the first `:` with `tag`. */
function replaceImageTag(image: string, tag: string): string {
  const index = image.indexOf(":");
  return image.slice(0, index + 1) + tag.trim();
}

/**
 * Resolve the edge-runtime image, honoring the pinned tag in
 * `supabase/.temp/edge-runtime-version` and the `deno_version` selector
 * (default 2 → v1.74.1; 1 → `deno1`). The version pin is applied first (Go's
 * `Load`), then `deno_version = 1` overrides to `deno1` (Go's validate pass).
 */
export const legacyResolveEdgeRuntimeImage = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  denoVersion: number,
) {
  let image = LEGACY_EDGE_RUNTIME_IMAGE;
  const versionPath = path.join(workdir, "supabase", ".temp", "edge-runtime-version");
  const pinned = yield* fs.readFileString(versionPath).pipe(
    Effect.map((s) => s.trim()),
    Effect.orElseSucceed(() => ""),
  );
  if (pinned.length > 0) {
    image = replaceImageTag(LEGACY_EDGE_RUNTIME_IMAGE, pinned);
  }
  if (denoVersion === 1) {
    image = LEGACY_EDGE_RUNTIME_DENO1_IMAGE;
  }
  return image;
});
