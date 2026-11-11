import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path } from "effect";

import { mockOutput } from "../../tests/helpers/mocks.ts";
import { listLocalMigrations } from "./migration-list.ts";

const project = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "migration-list-" });
  return { fs, path, root, migrationsDir: path.join(root, "supabase", "migrations") };
});

const list = (migrationsDir: string, out = mockOutput()) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* listLocalMigrations(fs, path, migrationsDir);
  }).pipe(Effect.provide(out.layer));

layer(BunServices.layer)("listLocalMigrations", (it) => {
  it.effect("returns sorted valid migrations, skipping a deprecated _init.sql first file", () =>
    Effect.gen(function* () {
      const { fs, path, migrationsDir } = yield* project;
      yield* fs.makeDirectory(migrationsDir, { recursive: true });
      yield* fs.writeFileString(path.join(migrationsDir, "20200101000000_init.sql"), "-- old init");
      yield* fs.writeFileString(
        path.join(migrationsDir, "20240101120000_create.sql"),
        "create table x();",
      );
      yield* fs.writeFileString(path.join(migrationsDir, "notes.txt"), "ignore me");
      const paths = yield* list(migrationsDir);
      expect(paths.map((p) => p.split("/").pop())).toEqual(["20240101120000_create.sql"]);
    }),
  );

  it.effect(
    "warns (byte-exact, on stderr) when skipping a deprecated init and a misnamed file",
    () =>
      Effect.gen(function* () {
        const { fs, path, migrationsDir } = yield* project;
        yield* fs.makeDirectory(migrationsDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(migrationsDir, "20200101000000_init.sql"),
          "-- old init",
        );
        yield* fs.writeFileString(
          path.join(migrationsDir, "20240101120000_create.sql"),
          "create table x();",
        );
        yield* fs.writeFileString(path.join(migrationsDir, "notes.txt"), "ignore me");
        const out = mockOutput();
        const paths = yield* list(migrationsDir, out);
        expect(paths.map((p) => p.split("/").pop())).toEqual(["20240101120000_create.sql"]);
        const stderr = out.rawChunks.filter((c) => c.stream === "stderr").map((c) => c.text);
        expect(stderr).toContain(
          'Skipping migration 20200101000000_init.sql... (replace "init" with a different file name to apply this migration)\n',
        );
        expect(stderr).toContain(
          'Skipping migration notes.txt... (file name must match pattern "<timestamp>_name.sql")\n',
        );
      }),
  );

  it.effect("includes a validly-named .sql symlink to a directory (no symlink follow)", () =>
    Effect.gen(function* () {
      const { fs, path, root, migrationsDir } = yield* project;
      yield* fs.makeDirectory(migrationsDir, { recursive: true });
      const targetDir = path.join(root, "outside-target");
      yield* fs.makeDirectory(targetDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(migrationsDir, "20240101120000_create.sql"),
        "create table x();",
      );
      yield* fs.symlink(targetDir, path.join(migrationsDir, "20240102000000_link.sql"));
      const paths = yield* list(migrationsDir);
      expect(paths.map((p) => p.split("/").pop())).toEqual([
        "20240101120000_create.sql",
        "20240102000000_link.sql",
      ]);
    }),
  );

  it.effect("sorts by UTF-8 byte order, not JS's default UTF-16 code-unit order", () =>
    Effect.gen(function* () {
      // U+E000 (BMP private-use, single UTF-16 code unit 0xE000) and U+1F600 (supplementary-plane,
      // a surrogate pair starting 0xD83D) sort in opposite order under UTF-16 code units vs. UTF-8
      // bytes: JS's default `.sort()` ranks the surrogate pair first (0xD83D < 0xE000), while byte
      // order (which preserves codepoint order) ranks U+1F600 after U+E000.
      const { fs, path, migrationsDir } = yield* project;
      yield* fs.makeDirectory(migrationsDir, { recursive: true });
      const privateUseFile = "20240101120000_z\uE000.sql";
      const supplementaryFile = "20240101120000_z\u{1F600}.sql";
      yield* fs.writeFileString(path.join(migrationsDir, privateUseFile), "create table x();");
      yield* fs.writeFileString(path.join(migrationsDir, supplementaryFile), "create table y();");
      const paths = yield* list(migrationsDir);
      expect(paths.map((p) => p.split("/").pop())).toEqual([privateUseFile, supplementaryFile]);
    }),
  );

  it.effect("returns [] when the migrations dir is absent", () =>
    Effect.gen(function* () {
      const { path, root } = yield* project;
      expect(yield* list(path.join(root, "nope"))).toEqual([]);
    }),
  );

  it.effect("fails (instead of returning []) when the migrations path is unreadable", () =>
    Effect.gen(function* () {
      const { fs, path, root, migrationsDir } = yield* project;
      yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });
      yield* fs.writeFileString(migrationsDir, "not a directory");
      const exit = yield* list(migrationsDir).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
