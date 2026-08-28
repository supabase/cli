import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { afterEach, vi } from "vitest";

import {
  dockerfileServiceImage,
  dockerfileServiceImageRaw,
} from "../../shared/services/dockerfile-images.ts";
import { toSlimImage } from "../../shared/services/slim-images.ts";
import { legacyResolveDbImage } from "./legacy-db-image.ts";

const currentPostgres = dockerfileServiceImageRaw("pg");
const currentPostgresTag = currentPostgres.split(":")[1] ?? "";

const withTemp = () => mkdtempSync(join(tmpdir(), "legacy-db-image-"));

const writePin = (workdir: string, pinned: string) => {
  const dir = join(workdir, "supabase", ".temp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "postgres-version"), pinned);
};

const resolve = (workdir: string, majorVersion: number, orioledbVersion?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyResolveDbImage(fs, path, workdir, majorVersion, orioledbVersion);
  }).pipe(Effect.provide(BunServices.layer));

describe("legacyResolveDbImage", () => {
  it.effect("resolves the default Postgres image per major version", () => {
    const dir = withTemp();
    return Effect.gen(function* () {
      expect(yield* resolve(dir, 14)).toBe("supabase/postgres:14.1.0.89");
      expect(yield* resolve(dir, 15)).toBe("supabase/postgres:15.8.1.085");
      expect(yield* resolve(dir, 17)).toBe(dockerfileServiceImage("pg"));
      rmSync(dir, { recursive: true, force: true });
    });
  });

  it.effect("rewrites to the OrioleDB image on a 15/17 project (Go config.Validate)", () => {
    const dir = withTemp();
    return Effect.gen(function* () {
      // > 15.1.1.13 → `<ver>-orioledb`
      expect(yield* resolve(dir, 17, "16.0.0.1")).toBe("supabase/postgres:16.0.0.1-orioledb");
      expect(yield* resolve(dir, 15, "15.1.1.20")).toBe("supabase/postgres:15.1.1.20-orioledb");
      // <= 15.1.1.13 → `orioledb-<ver>`
      expect(yield* resolve(dir, 17, "15.1.0.55")).toBe("supabase/postgres:orioledb-15.1.0.55");
      rmSync(dir, { recursive: true, force: true });
    });
  });

  it.effect("ignores orioledb_version on a non-15/17 project", () => {
    const dir = withTemp();
    return Effect.gen(function* () {
      expect(yield* resolve(dir, 14, "16.0.0.1")).toBe("supabase/postgres:14.1.0.89");
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("pinned version with the slim-images flag on", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.effect("keeps a 13/14/15 fallback on docker.io, not the slim registry", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
      const dir = withTemp();
      writePin(dir, "15.8.1.100");
      return Effect.gen(function* () {
        expect(yield* resolve(dir, 15)).toBe("supabase/postgres:15.8.1.100");
        rmSync(dir, { recursive: true, force: true });
      });
    });

    it.effect("keeps a historical default-major pin on docker.io", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
      const dir = withTemp();
      writePin(dir, "17.9.9.999");
      return Effect.gen(function* () {
        expect(yield* resolve(dir, 17)).toBe("supabase/postgres:17.9.9.999");
        rmSync(dir, { recursive: true, force: true });
      });
    });

    it.effect("rewrites the current Dockerfile pin to the slim registry", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
      const dir = withTemp();
      writePin(dir, currentPostgresTag);
      return Effect.gen(function* () {
        expect(yield* resolve(dir, 17)).toBe(toSlimImage("pg", currentPostgres));
        rmSync(dir, { recursive: true, force: true });
      });
    });
  });
});
