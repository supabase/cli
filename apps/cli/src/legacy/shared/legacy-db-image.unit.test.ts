import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { afterEach, beforeEach, vi } from "vitest";

import {
  dockerfileServiceImage,
  dockerfileServiceImageRaw,
} from "../../shared/services/dockerfile-images.ts";
import {
  POSTGRES_FALLBACK_IMAGE_PG14,
  POSTGRES_FALLBACK_IMAGE_PG15,
} from "../../shared/services/services.shared.ts";
import { imageTag, toSlimImage } from "../../shared/services/slim-images.ts";
import { legacyResolveDbImage } from "./legacy-db-image.ts";

const currentPostgres = dockerfileServiceImageRaw("pg");
const currentPostgresTag = imageTag(currentPostgres) ?? "";
const pg15Tag = imageTag(POSTGRES_FALLBACK_IMAGE_PG15) ?? "";

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
  beforeEach(() => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.effect("resolves the default Postgres image per major version", () => {
    const dir = withTemp();
    return Effect.gen(function* () {
      expect(yield* resolve(dir, 13)).toEqual({
        image: POSTGRES_FALLBACK_IMAGE_PG15,
        configImage: POSTGRES_FALLBACK_IMAGE_PG15,
      });
      expect(yield* resolve(dir, 14)).toEqual({
        image: POSTGRES_FALLBACK_IMAGE_PG14,
        configImage: POSTGRES_FALLBACK_IMAGE_PG14,
      });
      expect(yield* resolve(dir, 15)).toEqual({
        image: POSTGRES_FALLBACK_IMAGE_PG15,
        configImage: POSTGRES_FALLBACK_IMAGE_PG15,
      });
      expect(yield* resolve(dir, 17)).toEqual({
        image: dockerfileServiceImage("pg"),
        configImage: currentPostgres,
      });
      rmSync(dir, { recursive: true, force: true });
    });
  });

  it.effect("rewrites to the OrioleDB image on a 15/17 project (Go config.Validate)", () => {
    const dir = withTemp();
    return Effect.gen(function* () {
      // > 15.1.1.13 → `<ver>-orioledb`
      expect(yield* resolve(dir, 17, "16.0.0.1")).toEqual({
        image: "supabase/postgres:16.0.0.1-orioledb",
        configImage: "supabase/postgres:16.0.0.1-orioledb",
      });
      expect(yield* resolve(dir, 15, "15.1.1.20")).toEqual({
        image: "supabase/postgres:15.1.1.20-orioledb",
        configImage: "supabase/postgres:15.1.1.20-orioledb",
      });
      // <= 15.1.1.13 → `orioledb-<ver>`
      expect(yield* resolve(dir, 17, "15.1.0.55")).toEqual({
        image: "supabase/postgres:orioledb-15.1.0.55",
        configImage: "supabase/postgres:orioledb-15.1.0.55",
      });
      rmSync(dir, { recursive: true, force: true });
    });
  });

  it.effect("ignores orioledb_version on a non-15/17 project", () => {
    const dir = withTemp();
    return Effect.gen(function* () {
      expect(yield* resolve(dir, 14, "16.0.0.1")).toEqual({
        image: POSTGRES_FALLBACK_IMAGE_PG14,
        configImage: POSTGRES_FALLBACK_IMAGE_PG14,
      });
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("pinned version with the slim-images flag on", () => {
    it.effect("keeps a 14 fallback on docker.io, not the slim registry", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
      const dir = withTemp();
      return Effect.gen(function* () {
        expect(yield* resolve(dir, 14)).toEqual({
          image: POSTGRES_FALLBACK_IMAGE_PG14,
          configImage: POSTGRES_FALLBACK_IMAGE_PG14,
        });
        rmSync(dir, { recursive: true, force: true });
      });
    });

    it.effect("rewrites the current PG15 fallback to the slim registry", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
      const dir = withTemp();
      return Effect.gen(function* () {
        expect(yield* resolve(dir, 15)).toEqual({
          image: toSlimImage("pg", POSTGRES_FALLBACK_IMAGE_PG15),
          configImage: POSTGRES_FALLBACK_IMAGE_PG15,
        });
        expect(yield* resolve(dir, 13)).toEqual({
          image: toSlimImage("pg", POSTGRES_FALLBACK_IMAGE_PG15),
          configImage: POSTGRES_FALLBACK_IMAGE_PG15,
        });
        rmSync(dir, { recursive: true, force: true });
      });
    });

    it.effect("keeps a historical PG15 pin on docker.io", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
      const dir = withTemp();
      writePin(dir, "15.8.1.100");
      return Effect.gen(function* () {
        expect(yield* resolve(dir, 15)).toEqual({
          image: "supabase/postgres:15.8.1.100",
          configImage: "supabase/postgres:15.8.1.100",
        });
        rmSync(dir, { recursive: true, force: true });
      });
    });

    it.effect("rewrites a current PG15 pin to the slim registry", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
      const dir = withTemp();
      writePin(dir, pg15Tag);
      return Effect.gen(function* () {
        expect(yield* resolve(dir, 15)).toEqual({
          image: toSlimImage("pg", POSTGRES_FALLBACK_IMAGE_PG15),
          configImage: POSTGRES_FALLBACK_IMAGE_PG15,
        });
        rmSync(dir, { recursive: true, force: true });
      });
    });

    it.effect("keeps a historical default-major pin on docker.io", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
      const dir = withTemp();
      writePin(dir, "17.9.9.999");
      return Effect.gen(function* () {
        expect(yield* resolve(dir, 17)).toEqual({
          image: "supabase/postgres:17.9.9.999",
          configImage: "supabase/postgres:17.9.9.999",
        });
        rmSync(dir, { recursive: true, force: true });
      });
    });

    it.effect("rewrites the current Dockerfile pin to the slim registry", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
      const dir = withTemp();
      writePin(dir, currentPostgresTag);
      return Effect.gen(function* () {
        expect(yield* resolve(dir, 17)).toEqual({
          image: toSlimImage("pg", currentPostgres),
          configImage: currentPostgres,
        });
        rmSync(dir, { recursive: true, force: true });
      });
    });
  });
});
