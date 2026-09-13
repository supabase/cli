import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path } from "effect";

import { Output } from "../shared/output/output.service.ts";
import { mockOutput } from "../../tests/helpers/mocks.ts";
import { listLocalMigrations } from "./migration-list.ts";

const withTemp = () => mkdtempSync(join(tmpdir(), "migration-list-"));

const run = <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path | Output>) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(BunServices.layer, mockOutput().layer)),
  ) as Effect.Effect<A>;

const withServices = <A>(
  body: (fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, unknown, Output>,
) =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* body(fs, path);
    }),
  );

describe("listLocalMigrations", () => {
  it.effect("returns sorted valid migrations, skipping a deprecated _init.sql first file", () => {
    const dir = withTemp();
    const migrationsDir = join(dir, "supabase", "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(join(migrationsDir, "20200101000000_init.sql"), "-- old init");
    writeFileSync(join(migrationsDir, "20240101120000_create.sql"), "create table x();");
    writeFileSync(join(migrationsDir, "notes.txt"), "ignore me");
    return withServices((fs, path) => listLocalMigrations(fs, path, migrationsDir)).pipe(
      Effect.tap((paths) =>
        Effect.sync(() => {
          expect(paths.map((p) => p.split("/").pop())).toEqual(["20240101120000_create.sql"]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "warns (byte-exact, on stderr) when skipping a deprecated init and a misnamed file",
    () => {
      const dir = withTemp();
      const migrationsDir = join(dir, "supabase", "migrations");
      mkdirSync(migrationsDir, { recursive: true });
      writeFileSync(join(migrationsDir, "20200101000000_init.sql"), "-- old init");
      writeFileSync(join(migrationsDir, "20240101120000_create.sql"), "create table x();");
      writeFileSync(join(migrationsDir, "notes.txt"), "ignore me");
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        return yield* listLocalMigrations(fs, path, migrationsDir);
      }).pipe(
        Effect.provide(Layer.mergeAll(BunServices.layer, out.layer)),
        Effect.tap((paths) =>
          Effect.sync(() => {
            expect(paths.map((p) => p.split("/").pop())).toEqual(["20240101120000_create.sql"]);
            const stderr = out.rawChunks.filter((c) => c.stream === "stderr").map((c) => c.text);
            expect(stderr).toContain(
              'Skipping migration 20200101000000_init.sql... (replace "init" with a different file name to apply this migration)\n',
            );
            expect(stderr).toContain(
              'Skipping migration notes.txt... (file name must match pattern "<timestamp>_name.sql")\n',
            );
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      ) as Effect.Effect<unknown>;
    },
  );

  it.effect("includes a validly-named .sql symlink to a directory (no symlink follow)", () => {
    const dir = withTemp();
    const migrationsDir = join(dir, "supabase", "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    const targetDir = join(dir, "outside-target");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(migrationsDir, "20240101120000_create.sql"), "create table x();");
    symlinkSync(targetDir, join(migrationsDir, "20240102000000_link.sql"));
    return withServices((fs, path) => listLocalMigrations(fs, path, migrationsDir)).pipe(
      Effect.tap((paths) =>
        Effect.sync(() => {
          expect(paths.map((p) => p.split("/").pop())).toEqual([
            "20240101120000_create.sql",
            "20240102000000_link.sql",
          ]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("sorts by UTF-8 byte order, not JS's default UTF-16 code-unit order", () => {
    // U+E000 (BMP private-use, single UTF-16 code unit 0xE000) and U+1F600 (supplementary-plane,
    // a surrogate pair starting 0xD83D) sort in opposite order under UTF-16 code units vs. UTF-8
    // bytes: JS's default `.sort()` ranks the surrogate pair first (0xD83D < 0xE000), while byte
    // order (which preserves codepoint order) ranks U+1F600 after U+E000.
    const dir = withTemp();
    const migrationsDir = join(dir, "supabase", "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    const privateUseFile = "20240101120000_z\uE000.sql";
    const supplementaryFile = "20240101120000_z\u{1F600}.sql";
    writeFileSync(join(migrationsDir, privateUseFile), "create table x();");
    writeFileSync(join(migrationsDir, supplementaryFile), "create table y();");
    return withServices((fs, path) => listLocalMigrations(fs, path, migrationsDir)).pipe(
      Effect.tap((paths) =>
        Effect.sync(() => {
          expect(paths.map((p) => p.split("/").pop())).toEqual([privateUseFile, supplementaryFile]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("returns [] when the migrations dir is absent", () => {
    const dir = withTemp();
    return withServices((fs, path) => listLocalMigrations(fs, path, join(dir, "nope"))).pipe(
      Effect.tap((paths) =>
        Effect.sync(() => {
          expect(paths).toEqual([]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("fails (instead of returning []) when the migrations path is unreadable", () => {
    const dir = withTemp();
    const migrationsPath = join(dir, "supabase", "migrations");
    mkdirSync(join(dir, "supabase"), { recursive: true });
    writeFileSync(migrationsPath, "not a directory");
    return withServices((fs, path) =>
      listLocalMigrations(fs, path, migrationsPath).pipe(Effect.exit),
    ).pipe(
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});
