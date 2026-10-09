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
} from "../shared/services/dockerfile-images.ts";
import { imageTag } from "../shared/services/slim-images.ts";
import { expectedPinnedImage, GHCR_SLIM_IMAGE_PATTERN } from "../../tests/helpers/slim-images.ts";
import { resolveDbImage } from "./db-image.ts";

const currentPostgres = dockerfileServiceImageRaw("pg");
const currentPostgresTag = imageTag(currentPostgres) ?? "";
// PG13/15 and PG14 now come from the Dockerfile's generated `pg15`/hand-pinned `pg14` stages
// (the single version table), not hardcoded fallback constants.
const pg15Image = dockerfileServiceImageRaw("pg15");
const pg15Tag = imageTag(pg15Image) ?? "";
const pg14Image = dockerfileServiceImageRaw("pg14");

const withTemp = () => mkdtempSync(join(tmpdir(), "db-image-"));

const writePin = (workdir: string, pinned: string) => {
  const dir = join(workdir, "supabase", ".temp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "postgres-version"), pinned);
};

const resolve = (workdir: string, majorVersion: number, orioledbVersion?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* resolveDbImage(fs, path, workdir, majorVersion, orioledbVersion);
  }).pipe(Effect.provide(BunServices.layer));

describe("resolveDbImage", () => {
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
        image: pg15Image,
        configImage: pg15Image,
      });
      expect(yield* resolve(dir, 14)).toEqual({
        image: pg14Image,
        configImage: pg14Image,
      });
      expect(yield* resolve(dir, 15)).toEqual({
        image: pg15Image,
        configImage: pg15Image,
      });
      expect(yield* resolve(dir, 17)).toEqual({
        image: dockerfileServiceImage("pg", false),
        configImage: currentPostgres,
      });
      rmSync(dir, { recursive: true, force: true });
    });
  });

  it.effect("rewrites to the OrioleDB image on a 15/17 project", () => {
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
        image: pg14Image,
        configImage: pg14Image,
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
          image: pg14Image,
          configImage: pg14Image,
        });
        rmSync(dir, { recursive: true, force: true });
      });
    });

    it.effect("rewrites the current PG15 default tag to its catalog-pinned slim image", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
      const dir = withTemp();
      const pinned = expectedPinnedImage("pg", pg15Image);
      expect(pinned).toMatch(GHCR_SLIM_IMAGE_PATTERN);
      return Effect.gen(function* () {
        expect(yield* resolve(dir, 15)).toEqual({
          image: pinned,
          configImage: pg15Image,
        });
        expect(yield* resolve(dir, 13)).toEqual({
          image: pinned,
          configImage: pg15Image,
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

    it.effect("rewrites a current PG15 pin to its catalog-pinned slim image", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
      const dir = withTemp();
      writePin(dir, pg15Tag);
      const pinned = expectedPinnedImage("pg", pg15Image);
      expect(pinned).toMatch(GHCR_SLIM_IMAGE_PATTERN);
      return Effect.gen(function* () {
        expect(yield* resolve(dir, 15)).toEqual({
          image: pinned,
          configImage: pg15Image,
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

    it.effect("rewrites the current Dockerfile pin to its catalog-pinned slim image", () => {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
      const dir = withTemp();
      writePin(dir, currentPostgresTag);
      const pinned = expectedPinnedImage("pg", currentPostgres);
      expect(pinned).toMatch(GHCR_SLIM_IMAGE_PATTERN);
      return Effect.gen(function* () {
        expect(yield* resolve(dir, 17)).toEqual({
          image: pinned,
          configImage: currentPostgres,
        });
        rmSync(dir, { recursive: true, force: true });
      });
    });
  });
});
