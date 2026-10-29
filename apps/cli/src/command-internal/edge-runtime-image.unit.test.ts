import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { vi } from "vitest";

import {
  dockerfileServiceImage,
  dockerfileServiceImageRaw,
} from "../shared/services/dockerfile-images.ts";
import { expectedPinnedImage, GHCR_SLIM_IMAGE_PATTERN } from "../../tests/helpers/slim-images.ts";
import { slimImagesEnabled } from "../shared/services/slim-images.ts";
import { resolveEdgeRuntimeImage } from "./edge-runtime-image.ts";

const currentEdgeRuntime = dockerfileServiceImageRaw("edgeruntime");
const currentEdgeRuntimeTag = currentEdgeRuntime.split(":")[1] ?? "";

const resolve = (denoVersion: number, pin?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "edge-img-" });
    if (pin !== undefined) {
      const tempDir = path.join(dir, "supabase", ".temp");
      yield* fs.makeDirectory(tempDir, { recursive: true });
      yield* fs.writeFileString(path.join(tempDir, "edge-runtime-version"), pin);
    }
    return yield* resolveEdgeRuntimeImage(fs, path, dir, denoVersion);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("resolveEdgeRuntimeImage", () => {
  it.effect("returns the edge-runtime image from the Dockerfile when nothing is pinned", () =>
    Effect.gen(function* () {
      const [image, slim] = yield* Effect.zip(resolve(2), slimImagesEnabled);
      expect(image).toBe(dockerfileServiceImage("edgeruntime", slim));
    }),
  );

  it.effect("honors the pinned tag in .temp/edge-runtime-version", () =>
    Effect.gen(function* () {
      expect(yield* resolve(2, "v9.9.9\n")).toBe("supabase/edge-runtime:v9.9.9");
    }),
  );

  it.effect("selects the deno1 image when deno_version = 1", () =>
    Effect.gen(function* () {
      expect(yield* resolve(1)).toBe("supabase/edge-runtime:v1.68.4");
    }),
  );

  describe("with the slim-images flag on", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.effect("keeps a historical pin on docker.io", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
      return Effect.gen(function* () {
        expect(yield* resolve(2, "v9.9.9\n")).toBe("supabase/edge-runtime:v9.9.9");
      });
    });

    it.effect("rewrites the current Dockerfile pin to its catalog-pinned slim image", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
      const pinned = expectedPinnedImage("edgeruntime", currentEdgeRuntime);
      expect(pinned).toMatch(GHCR_SLIM_IMAGE_PATTERN);
      return Effect.gen(function* () {
        expect(yield* resolve(2, `${currentEdgeRuntimeTag}\n`)).toBe(pinned);
      });
    });

    it.effect("keeps a deno1-tag pin on docker.io, where that tag exists", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
      return Effect.gen(function* () {
        expect(yield* resolve(2, "v1.68.4\n")).toBe("supabase/edge-runtime:v1.68.4");
      });
    });
  });
});
