import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path } from "effect";

import { legacyCollectMigrationsList, legacySaveDebugBundle } from "./declarative.debug-bundle.ts";

const save = (workdir: string, tempDir: string, migrationsDir: string, id: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacySaveDebugBundle(fs, path, workdir, tempDir, migrationsDir, {
      id,
      error: "boom",
      migrationSql: "create table t();",
    });
  }).pipe(Effect.provide(BunServices.layer));

describe("legacySaveDebugBundle", () => {
  it.effect("writes artifacts and returns the debug directory", () => {
    const root = mkdtempSync(join(tmpdir(), "legacy-debug-"));
    const tempDir = join(root, "supabase", ".temp", "pgdelta");
    return save(root, tempDir, join(root, "supabase", "migrations"), "20240101-000000").pipe(
      Effect.tap((debugDir) =>
        Effect.sync(() => {
          expect(debugDir).toBe(join(tempDir, "debug", "20240101-000000"));
          expect(existsSync(join(debugDir, "generated-migration.sql"))).toBe(true);
          expect(readFileSync(join(debugDir, "error.txt"), "utf8")).toBe("boom");
          rmSync(root, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("fails (does not return a path) when the debug directory cannot be created", () => {
    // Plant a regular file where the `debug` directory needs to be, so the recursive
    // makeDirectory fails — Go's SaveDebugBundle returns an error here rather than
    // claiming a bundle was saved.
    const root = mkdtempSync(join(tmpdir(), "legacy-debug-fail-"));
    const tempDir = join(root, "pgdelta");
    writeFileSync(join(root, "pgdelta"), "not a directory");
    return save(root, tempDir, join(root, "migrations"), "20240101-000000").pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          rmSync(root, { recursive: true, force: true });
        }),
      ),
    );
  });
});

const collect = (migrationsDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyCollectMigrationsList(fs, path, migrationsDir);
  }).pipe(Effect.provide(BunServices.layer));

describe("legacyCollectMigrationsList", () => {
  it.effect("returns migration filenames when the dir is readable", () => {
    const root = mkdtempSync(join(tmpdir(), "legacy-collect-"));
    const migrationsDir = join(root, "supabase", "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(join(migrationsDir, "20240101120000_create.sql"), "create table x();");
    return collect(migrationsDir).pipe(
      Effect.tap((names) =>
        Effect.sync(() => {
          expect(names).toEqual(["20240101120000_create.sql"]);
          rmSync(root, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "swallows an unreadable migrations dir (returns []) so it never masks the primary error",
    () => {
      // Go's CollectMigrationsList returns nil on a read error; the debug bundle just
      // omits migration copies rather than replacing the in-flight diff/apply error.
      const root = mkdtempSync(join(tmpdir(), "legacy-collect-fail-"));
      const migrationsPath = join(root, "migrations");
      writeFileSync(migrationsPath, "not a directory");
      return collect(migrationsPath).pipe(
        Effect.tap((names) =>
          Effect.sync(() => {
            expect(names).toEqual([]);
            rmSync(root, { recursive: true, force: true });
          }),
        ),
      );
    },
  );
});
