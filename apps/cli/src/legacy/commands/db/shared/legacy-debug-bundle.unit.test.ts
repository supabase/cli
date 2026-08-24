import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { legacyCollectMigrationsList, legacySaveDebugBundle } from "./legacy-debug-bundle.ts";

describe("legacySaveDebugBundle", () => {
  it.effect("writes artifacts and returns the debug directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "legacy-debug-" });
      const tempDir = path.join(root, "supabase", ".temp", "pgdelta");
      const debugDir = yield* legacySaveDebugBundle(
        fs,
        path,
        root,
        tempDir,
        path.join(root, "supabase", "migrations"),
        { id: "20240101-000000", error: "boom", migrationSql: "create table t();" },
      );
      expect(debugDir).toBe(path.join(tempDir, "debug", "20240101-000000"));
      expect(yield* fs.exists(path.join(debugDir, "generated-migration.sql"))).toBe(true);
      expect(yield* fs.readFileString(path.join(debugDir, "error.txt"))).toBe("boom");
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, mockOutput().layer))),
  );

  it.effect("fails (does not return a path) when the debug directory cannot be created", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "legacy-debug-fail-" });
      const tempDir = path.join(root, "pgdelta");
      yield* fs.writeFileString(tempDir, "not a directory");
      const exit = yield* legacySaveDebugBundle(
        fs,
        path,
        root,
        tempDir,
        path.join(root, "migrations"),
        { id: "20240101-000000", error: "boom", migrationSql: "create table t();" },
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, mockOutput().layer))),
  );
});

describe("legacyCollectMigrationsList", () => {
  it.effect("returns migration filenames when the dir is readable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "legacy-collect-" });
      const migrationsDir = path.join(root, "supabase", "migrations");
      yield* fs.makeDirectory(migrationsDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(migrationsDir, "20240101120000_create.sql"),
        "create table x();",
      );
      expect(yield* legacyCollectMigrationsList(fs, path, migrationsDir)).toEqual([
        "20240101120000_create.sql",
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, mockOutput().layer))),
  );

  it.effect(
    "swallows an unreadable migrations dir (returns []) so it never masks the primary error",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "legacy-collect-fail-" });
        const migrationsPath = path.join(root, "migrations");
        yield* fs.writeFileString(migrationsPath, "not a directory");
        expect(yield* legacyCollectMigrationsList(fs, path, migrationsPath)).toEqual([]);
      }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, mockOutput().layer))),
  );
});
