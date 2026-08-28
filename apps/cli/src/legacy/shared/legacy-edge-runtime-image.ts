import { Effect, type FileSystem, type Path } from "effect";
import { DENO1_EDGE_RUNTIME_VERSION } from "../../shared/functions/functions.shared.ts";
import {
  dockerfileServiceImage,
  dockerfileServiceImageRaw,
} from "../../shared/services/dockerfile-images.ts";
import { slimImageForCurrentPin } from "../../shared/services/slim-images.ts";

/**
 * Resolves the edge-runtime Docker image the way Go's `config.Load` does
 * (`apps/cli-go/pkg/config/config.go:445,682-683,999-1007`), for the
 * declarative pg-delta scripts that run inside the edge-runtime container.
 *
 * The default tag is baked into the Go binary via the embedded Dockerfile. A
 * pinned tag in `supabase/.temp/edge-runtime-version` overrides it (written by
 * `supabase start`). `edge_runtime.deno_version = 1` selects the legacy `deno1`
 * image instead (default `deno_version = 2` keeps the Dockerfile image).
 */

// Read per call, not captured at import time, so `SUPABASE_USE_SLIM_IMAGES` is
// observed by the resolver (and by tests that stub the env).
export const legacyEdgeRuntimeImage = () => dockerfileServiceImage("edgeruntime");
// `deno1` (`pkg/config/constants.go:15`) — used when `deno_version = 1`. No slim
// build exists for it, so it stays on docker.io regardless of the flag — the
// same exception `edgeRuntimeImage` (`shared/functions/functions.shared.ts`)
// applies for the functions Docker paths reading the SAME pin file.
const LEGACY_EDGE_RUNTIME_DENO1_IMAGE = `supabase/edge-runtime:${DENO1_EDGE_RUNTIME_VERSION}`;

const resolveEdgeRuntimeImage = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  denoVersion: number,
) {
  if (denoVersion === 1) {
    return LEGACY_EDGE_RUNTIME_DENO1_IMAGE;
  }
  const raw = dockerfileServiceImageRaw("edgeruntime");
  const versionPath = path.join(workdir, "supabase", ".temp", "edge-runtime-version");
  const pinned = yield* fs.readFileString(versionPath).pipe(
    Effect.map((s) => s.trim()),
    Effect.orElseSucceed(() => ""),
  );
  if (pinned === DENO1_EDGE_RUNTIME_VERSION) {
    return LEGACY_EDGE_RUNTIME_DENO1_IMAGE;
  }
  return slimImageForCurrentPin("edgeruntime", raw, pinned.length > 0 ? pinned : undefined);
});

/**
 * Resolve the edge-runtime image, honoring the pinned tag in
 * `supabase/.temp/edge-runtime-version` and the `deno_version` selector
 * (default 2 → Dockerfile image; 1 → `deno1`). The version pin is applied first
 * (Go's `Load`), then `deno_version = 1` overrides to `deno1` (Go's validate
 * pass). Historical pins stay on docker.io — those slim tags are not published.
 */
export const legacyResolveEdgeRuntimeImage = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  denoVersion: number,
) => resolveEdgeRuntimeImage(fs, path, workdir, denoVersion);
