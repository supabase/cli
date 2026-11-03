import { legacyProjectStatePaths } from "../shared/config/legacy-project-state.paths.ts";
import { usesStackState } from "./stack-backend.ts";
import { Effect, type FileSystem, Option, type Path } from "effect";
import { DENO1_EDGE_RUNTIME_VERSION } from "../shared/functions/functions.shared.ts";
import {
  dockerfileServiceImage,
  dockerfileServiceImageRaw,
} from "../shared/services/dockerfile-images.ts";
import {
  imageTag,
  slimImageForCurrentPin,
  slimImagesEnabled,
} from "../shared/services/slim-images.ts";
import { readLockedPins } from "./stack-lock.ts";

/**
 * Resolves the edge-runtime Docker image: the default tag comes from the Dockerfile image, a
 * pinned tag in `supabase/.temp/edge-runtime-version` overrides it, and
 * `edge_runtime.deno_version = 1` selects the legacy `deno1` image instead.
 */

// Read per run, not captured at import time, so `SUPABASE_USE_SLIM_IMAGES` is observed.
export const edgeRuntimeDockerfileImage = Effect.map(slimImagesEnabled, (slim) =>
  dockerfileServiceImage("edgeruntime", slim),
);
// Used when `deno_version = 1`. No slim build exists for it, so it stays on docker.io regardless
// of the flag — the same exception `edgeRuntimeImage` (`shared/functions/functions.shared.ts`)
// applies for the functions Docker paths reading the same pin file.
const EDGE_RUNTIME_DENO1_IMAGE = `supabase/edge-runtime:${DENO1_EDGE_RUNTIME_VERSION}`;

const imageForPin = Effect.fnUntraced(function* (pinned: string) {
  if (pinned === DENO1_EDGE_RUNTIME_VERSION) {
    return EDGE_RUNTIME_DENO1_IMAGE;
  }
  return slimImageForCurrentPin(
    "edgeruntime",
    dockerfileServiceImageRaw("edgeruntime"),
    pinned.length > 0 ? pinned : undefined,
    yield* slimImagesEnabled,
  );
});

/**
 * Resolves the edge-runtime image, honoring the pinned tag in
 * `supabase/.temp/edge-runtime-version` (legacy state only; stack state uses
 * {@link resolveLockedEdgeRuntimeImage}) and the `deno_version` selector
 * (default 2 → Dockerfile image; 1 → `deno1`). The version pin is applied first, then
 * `deno_version = 1` overrides to `deno1`. Historical pins stay on docker.io — those slim tags
 * are not published.
 */
export const resolveEdgeRuntimeImage = Effect.fn("EdgeRuntimeImage.resolve")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  denoVersion: number,
) {
  if (denoVersion === 1) {
    return EDGE_RUNTIME_DENO1_IMAGE;
  }
  const pinned = (yield* usesStackState)
    ? ""
    : yield* fs.readFileString(legacyProjectStatePaths(path, workdir).edgeRuntimeVersion).pipe(
        Effect.map((s) => s.trim()),
        Effect.orElseSucceed(() => ""),
      );
  return yield* imageForPin(pinned);
});

/**
 * The edge-runtime image for tool containers in stack state mode: the release locked for
 * Functions in `supabase/supabase.lock` (the pinned slim image when slim images are enabled, else
 * its upstream image), else the bundled one. Reads only the lock, so a stale lock or an invalid
 * config does not block it; an unreadable lock fails.
 */
export const resolveLockedEdgeRuntimeImage = Effect.fn("EdgeRuntimeImage.resolveLocked")(function* (
  workdir: string,
  denoVersion: number,
) {
  if (denoVersion === 1) {
    return EDGE_RUNTIME_DENO1_IMAGE;
  }
  const locked = yield* readLockedPins(workdir);
  if (Option.isSome(locked) && (yield* slimImagesEnabled)) {
    return locked.value.functions.image;
  }
  return yield* imageForPin(
    Option.match(locked, {
      onNone: () => "",
      onSome: (selection) => imageTag(selection.functions.upstreamImage) ?? "",
    }),
  );
});
