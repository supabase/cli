import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path } from "effect";

import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { collectMigrationsList, saveDebugBundle } from "./debug-bundle.ts";

const save = (workdir: string, tempDir: string, migrationsDir: string, id: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* saveDebugBundle(fs, path, workdir, tempDir, migrationsDir, {
      id,
      error: "boom",
      migrationSql: "create table t();",
    });
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, mockOutput().layer)));

describe("saveDebugBundle", () => {
  it.effect("writes artifacts and returns the debug directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "debug-" });
      const tempDir = path.join(root, "supabase", ".temp", "pgdelta");
      const debugDir = yield* save(
        root,
        tempDir,
        path.join(root, "supabase", "migrations"),
        "20240101-000000",
      );
      expect(debugDir).toBe(path.join(tempDir, "debug", "20240101-000000"));
      expect(yield* fs.exists(path.join(debugDir, "generated-migration.sql"))).toBe(true);
      expect(yield* fs.readFileString(path.join(debugDir, "error.txt"))).toBe("boom");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("fails (does not return a path) when the debug directory cannot be created", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Plants a regular file where the `debug` directory needs to be, so the recursive
      // makeDirectory fails.
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "debug-fail-" });
      const tempDir = path.join(root, "pgdelta");
      yield* fs.writeFileString(path.join(root, "pgdelta"), "not a directory");
      const exit = yield* save(
        root,
        tempDir,
        path.join(root, "migrations"),
        "20240101-000000",
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});

const collect = (migrationsDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* collectMigrationsList(fs, path, migrationsDir);
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, mockOutput().layer)));

describe("collectMigrationsList", () => {
  it.effect("returns migration filenames when the dir is readable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "collect-" });
      const migrationsDir = path.join(root, "supabase", "migrations");
      yield* fs.makeDirectory(migrationsDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(migrationsDir, "20240101120000_create.sql"),
        "create table x();",
      );
      const names = yield* collect(migrationsDir);
      expect(names).toEqual(["20240101120000_create.sql"]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "swallows an unreadable migrations dir (returns []) so it never masks the primary error",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "collect-fail-" });
        const migrationsPath = path.join(root, "migrations");
        yield* fs.writeFileString(migrationsPath, "not a directory");
        const names = yield* collect(migrationsPath);
        expect(names).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
