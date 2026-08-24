import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { dockerfileServiceImage } from "../../shared/services/dockerfile-images.ts";
import { legacyResolveDbImage } from "./legacy-db-image.ts";

const resolve = (workdir: string, majorVersion: number, orioledbVersion?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyResolveDbImage(fs, path, workdir, majorVersion, orioledbVersion);
  }).pipe(Effect.provide(BunServices.layer));

describe("legacyResolveDbImage", () => {
  it.effect("resolves the default Postgres image per major version", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "legacy-db-image-" });
      expect(yield* resolve(dir, 14)).toBe("supabase/postgres:14.1.0.89");
      expect(yield* resolve(dir, 15)).toBe("supabase/postgres:15.8.1.085");
      expect(yield* resolve(dir, 17)).toBe(dockerfileServiceImage("pg"));
      yield* fs.remove(dir, { recursive: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("rewrites to the OrioleDB image on a 15/17 project (Go config.Validate)", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "legacy-db-image-" });
      // > 15.1.1.13 → `<ver>-orioledb`
      expect(yield* resolve(dir, 17, "16.0.0.1")).toBe("supabase/postgres:16.0.0.1-orioledb");
      expect(yield* resolve(dir, 15, "15.1.1.20")).toBe("supabase/postgres:15.1.1.20-orioledb");
      // <= 15.1.1.13 → `orioledb-<ver>`
      expect(yield* resolve(dir, 17, "15.1.0.55")).toBe("supabase/postgres:orioledb-15.1.0.55");
      yield* fs.remove(dir, { recursive: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("ignores orioledb_version on a non-15/17 project", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "legacy-db-image-" });
      expect(yield* resolve(dir, 14, "16.0.0.1")).toBe("supabase/postgres:14.1.0.89");
      yield* fs.remove(dir, { recursive: true });
    }).pipe(Effect.provide(BunServices.layer));
  });
});
