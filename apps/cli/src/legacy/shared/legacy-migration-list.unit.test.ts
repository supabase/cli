import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { legacyListLocalMigrations } from "./legacy-migration-list.ts";

const withTemp = () => mkdtempSync(join(tmpdir(), "legacy-migration-list-"));

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

describe("legacyListLocalMigrations", () => {
  it.effect("returns sorted valid migrations, skipping a deprecated _init.sql first file", () => {
    const dir = withTemp();
    const migrationsDir = join(dir, "supabase", "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(join(migrationsDir, "20200101000000_init.sql"), "-- old init");
    writeFileSync(join(migrationsDir, "20240101120000_create.sql"), "create table x();");
    writeFileSync(join(migrationsDir, "notes.txt"), "ignore me");
    return withServices((fs, path) => legacyListLocalMigrations(fs, path, migrationsDir)).pipe(
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
      // One stderr line for the deprecated `_init.sql` first file and one for any
      // name that does not match `<timestamp>_name.sql`.
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
        return yield* legacyListLocalMigrations(fs, path, migrationsDir);
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
    // A directory entry is classified from its own type without following symlinks,
    // so a `.sql` symlink whose target is a directory is NOT skipped as a directory —
    // it is only ever dropped later, if something actually tries to read it as a
    // file. A naive stat-based directory check (which follows symlinks) would
    // misclassify it and silently skip it.
    const dir = withTemp();
    const migrationsDir = join(dir, "supabase", "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    const targetDir = join(dir, "outside-target");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(migrationsDir, "20240101120000_create.sql"), "create table x();");
    symlinkSync(targetDir, join(migrationsDir, "20240102000000_link.sql"));
    return withServices((fs, path) => legacyListLocalMigrations(fs, path, migrationsDir)).pipe(
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
    // Entries sort byte-wise over each name's UTF-8 encoding. A BMP private-use
    // character (U+E000, single UTF-16 code unit `0xE000`) and a supplementary-plane
    // character (U+1F600, a surrogate pair starting `0xD83D`) reverse order between
    // the two schemes: JS's default `Array.prototype.sort()` ranks the surrogate pair
    // first (`0xD83D < 0xE000`), while byte order — which preserves codepoint order —
    // ranks U+1F600 (`> U+FFFF`) after U+E000. A migrations directory with such
    // filenames must replay in byte order, or a dependent migration could apply out
    // of order.
    const dir = withTemp();
    const migrationsDir = join(dir, "supabase", "migrations");
    mkdirSync(migrationsDir, { recursive: true });
    const privateUseFile = "20240101120000_z\uE000.sql";
    const supplementaryFile = "20240101120000_z\u{1F600}.sql";
    writeFileSync(join(migrationsDir, privateUseFile), "create table x();");
    writeFileSync(join(migrationsDir, supplementaryFile), "create table y();");
    return withServices((fs, path) => legacyListLocalMigrations(fs, path, migrationsDir)).pipe(
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
    return withServices((fs, path) => legacyListLocalMigrations(fs, path, join(dir, "nope"))).pipe(
      Effect.tap((paths) =>
        Effect.sync(() => {
          expect(paths).toEqual([]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("fails (instead of returning []) when the migrations path is unreadable", () => {
    // `supabase/migrations` exists but is a file, not a directory — the lister
    // aborts with `failed to read directory` rather than treating it as "no
    // migrations".
    const dir = withTemp();
    const migrationsPath = join(dir, "supabase", "migrations");
    mkdirSync(join(dir, "supabase"), { recursive: true });
    writeFileSync(migrationsPath, "not a directory");
    return withServices((fs, path) =>
      legacyListLocalMigrations(fs, path, migrationsPath).pipe(Effect.exit),
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
