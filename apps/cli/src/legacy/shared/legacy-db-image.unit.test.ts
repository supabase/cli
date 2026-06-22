import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { dockerfileServiceImage } from "../../shared/services/dockerfile-images.ts";
import { legacyResolveDbImage } from "./legacy-db-image.ts";

const withTemp = () => mkdtempSync(join(tmpdir(), "legacy-db-image-"));

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
});
