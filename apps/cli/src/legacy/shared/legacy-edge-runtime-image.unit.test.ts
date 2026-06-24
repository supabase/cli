import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { legacyResolveEdgeRuntimeImage } from "./legacy-edge-runtime-image.ts";

const resolve = (workdir: string, denoVersion: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyResolveEdgeRuntimeImage(fs, path, workdir, denoVersion);
  }).pipe(Effect.provide(BunServices.layer));

describe("legacyResolveEdgeRuntimeImage", () => {
  it.effect("returns the default v1.74.1 image when nothing is pinned", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-edge-img-"));
    return resolve(dir, 2).pipe(
      Effect.tap((image) =>
        Effect.sync(() => {
          expect(image).toBe("supabase/edge-runtime:v1.74.1");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("honors the pinned tag in .temp/edge-runtime-version", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-edge-img-"));
    mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
    writeFileSync(join(dir, "supabase", ".temp", "edge-runtime-version"), "v9.9.9\n");
    return resolve(dir, 2).pipe(
      Effect.tap((image) =>
        Effect.sync(() => {
          expect(image).toBe("supabase/edge-runtime:v9.9.9");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("selects the deno1 image when deno_version = 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-edge-img-"));
    return resolve(dir, 1).pipe(
      Effect.tap((image) =>
        Effect.sync(() => {
          expect(image).toBe("supabase/edge-runtime:v1.68.4");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});
