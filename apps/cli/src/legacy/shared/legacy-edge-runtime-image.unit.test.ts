import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { vi } from "vitest";

import {
  dockerfileServiceImage,
  dockerfileServiceImageRaw,
} from "../../shared/services/dockerfile-images.ts";
import { toSlimImage } from "../../shared/services/slim-images.ts";
import {
  legacyResolveEdgeRuntimeImage,
  legacyResolveEdgeRuntimeShellImage,
} from "./legacy-edge-runtime-image.ts";

const currentEdgeRuntime = dockerfileServiceImageRaw("edgeruntime");
const currentEdgeRuntimeTag = currentEdgeRuntime.split(":")[1] ?? "";

const resolve = (workdir: string, denoVersion: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyResolveEdgeRuntimeImage(fs, path, workdir, denoVersion);
  }).pipe(Effect.provide(BunServices.layer));

const resolveShell = (workdir: string, denoVersion: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyResolveEdgeRuntimeShellImage(fs, path, workdir, denoVersion);
  }).pipe(Effect.provide(BunServices.layer));

describe("legacyResolveEdgeRuntimeImage", () => {
  it.effect("returns the edge-runtime image from the Dockerfile when nothing is pinned", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-edge-img-"));
    return resolve(dir, 2).pipe(
      Effect.tap((image) =>
        Effect.sync(() => {
          expect(image).toBe(dockerfileServiceImage("edgeruntime"));
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("resolves the shell-pinned variant to the same image while the flag is off", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-edge-img-"));
    return resolveShell(dir, 2).pipe(
      Effect.tap((image) =>
        Effect.sync(() => {
          expect(image).toBe(dockerfileServiceImage("edgeruntime"));
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

  describe("with the slim-images flag on", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.effect("keeps a historical pin on docker.io", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
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

    it.effect("rewrites the current Dockerfile pin onto the slim base", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
      const dir = mkdtempSync(join(tmpdir(), "legacy-edge-img-"));
      mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
      writeFileSync(
        join(dir, "supabase", ".temp", "edge-runtime-version"),
        `${currentEdgeRuntimeTag}\n`,
      );
      return resolve(dir, 2).pipe(
        Effect.tap((image) =>
          Effect.sync(() => {
            expect(image).toBe(toSlimImage("edgeruntime", currentEdgeRuntime));
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    });

    it.effect("keeps the shell-pinned resolution on docker.io, pin included", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
      const dir = mkdtempSync(join(tmpdir(), "legacy-edge-img-"));
      mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
      writeFileSync(join(dir, "supabase", ".temp", "edge-runtime-version"), "v9.9.9\n");
      return resolveShell(dir, 2).pipe(
        Effect.tap((image) =>
          Effect.sync(() => {
            expect(image).toBe("supabase/edge-runtime:v9.9.9");
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    });

    it.effect("keeps a deno1-tag pin on docker.io, where that tag exists", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
      const dir = mkdtempSync(join(tmpdir(), "legacy-edge-img-"));
      mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
      writeFileSync(join(dir, "supabase", ".temp", "edge-runtime-version"), "v1.68.4\n");
      return resolve(dir, 2).pipe(
        Effect.tap((image) =>
          Effect.sync(() => {
            expect(image).toBe("supabase/edge-runtime:v1.68.4");
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    });
  });
});
