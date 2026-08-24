import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { dockerfileServiceImage } from "../../shared/services/dockerfile-images.ts";
import { legacyResolveEdgeRuntimeImage } from "./legacy-edge-runtime-image.ts";

const resolve = (workdir: string, denoVersion: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyResolveEdgeRuntimeImage(fs, path, workdir, denoVersion);
  }).pipe(Effect.provide(BunServices.layer));

describe("legacyResolveEdgeRuntimeImage", () => {
  it.effect("returns the edge-runtime image from the Dockerfile when nothing is pinned", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "legacy-edge-img-" });
      const image = yield* resolve(dir, 2);
      expect(image).toBe(dockerfileServiceImage("edgeruntime"));
      yield* fs.remove(dir, { recursive: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("honors the pinned tag in .temp/edge-runtime-version", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "legacy-edge-img-" });
      const tempDir = path.join(dir, "supabase", ".temp");
      yield* fs.makeDirectory(tempDir, { recursive: true });
      yield* fs.writeFileString(path.join(tempDir, "edge-runtime-version"), "v9.9.9\n");
      const image = yield* resolve(dir, 2);
      expect(image).toBe("supabase/edge-runtime:v9.9.9");
      yield* fs.remove(dir, { recursive: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("selects the deno1 image when deno_version = 1", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "legacy-edge-img-" });
      const image = yield* resolve(dir, 1);
      expect(image).toBe("supabase/edge-runtime:v1.68.4");
      yield* fs.remove(dir, { recursive: true });
    }).pipe(Effect.provide(BunServices.layer));
  });
});
