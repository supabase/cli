import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, PlatformError } from "effect";

import {
  legacyLoadDeclaredSchemas,
  legacyShouldApplyDeclarativeWithPgDelta,
} from "./legacy-shadow-source.ts";
import type { LegacyPgDeltaTomlConfig } from "../../../shared/legacy-db-config.toml-read.ts";

function pgDelta(overrides: Partial<LegacyPgDeltaTomlConfig> = {}): LegacyPgDeltaTomlConfig {
  return {
    enabled: false,
    declarativeSchemaPath: Option.none(),
    formatOptions: Option.none(),
    npmVersion: Option.none(),
    ...overrides,
  };
}

function makeWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "legacy-shadow-source-"));
}

// Root bypasses POSIX permission bits, so chmod 000 wouldn't block readdir() there.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("legacyShouldApplyDeclarativeWithPgDelta", () => {
  it.effect("is false whenever usePgDelta is false, regardless of schema_paths", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(legacyShouldApplyDeclarativeWithPgDelta(path, false, [], pgDelta())).toBe(false);
      expect(
        legacyShouldApplyDeclarativeWithPgDelta(path, false, ["schemas/x.sql"], pgDelta()),
      ).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("is true when usePgDelta and zero schema_paths are configured", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(legacyShouldApplyDeclarativeWithPgDelta(path, true, [], pgDelta())).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("is false when more than one schema_paths entry is configured", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        legacyShouldApplyDeclarativeWithPgDelta(path, true, ["a.sql", "b.sql"], pgDelta()),
      ).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "is true when exactly one schema_paths entry resolves to the effective declarative dir",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(legacyShouldApplyDeclarativeWithPgDelta(path, true, ["database"], pgDelta())).toBe(
          true,
        );
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("is false when the single schema_paths entry does not match the declarative dir", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(legacyShouldApplyDeclarativeWithPgDelta(path, true, ["schemas"], pgDelta())).toBe(
        false,
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("matches a configured (non-default) declarative_schema_path the same way", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const configured = pgDelta({ declarativeSchemaPath: Option.some("supabase/custom-decl") });
      expect(legacyShouldApplyDeclarativeWithPgDelta(path, true, ["custom-decl"], configured)).toBe(
        true,
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "on POSIX, a backslash in schema_paths is a literal character, not a path separator",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        // Go's `filepath.Clean`/`ToSlash` only treat `\` as a separator on a Windows build —
        // on darwin/linux it's untouched, so a `foo\bar` schema_paths entry (which
        // `legacyResolveSeedSqlPath` joins under `supabase/` unresolved) must NOT be treated
        // as equivalent to the slash-separated declarative dir `supabase/foo/bar`.
        const configured = pgDelta({ declarativeSchemaPath: Option.some("supabase/foo/bar") });
        expect(
          legacyShouldApplyDeclarativeWithPgDelta(path, true, ["foo\\bar"], configured, "darwin"),
        ).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("on win32, a backslash in schema_paths normalizes as a path separator", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const configured = pgDelta({ declarativeSchemaPath: Option.some("supabase/foo/bar") });
      expect(
        legacyShouldApplyDeclarativeWithPgDelta(path, true, ["foo\\bar"], configured, "win32"),
      ).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("legacyLoadDeclaredSchemas", () => {
  it.effect(
    "returns [] when neither schema_paths, an enabled pg-delta dir, nor supabase/schemas exist",
    () => {
      const workdir = makeWorkdir();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(fs, path, workdir, [], pgDelta());
        expect(result).toEqual([]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "falls back to sorted supabase/schemas/*.sql when no schema_paths/pg-delta dir apply",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "schemas"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "schemas", "b.sql"), "select 2;\n");
      writeFileSync(join(workdir, "supabase", "schemas", "a.sql"), "select 1;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(fs, path, workdir, [], pgDelta());
        expect(result).toEqual(["supabase/schemas/a.sql", "supabase/schemas/b.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "prefers the pg-delta declarative dir over supabase/schemas when pg-delta is enabled and the dir exists",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "database"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "database", "t.sql"), "select 1;\n");
      mkdirSync(join(workdir, "supabase", "schemas"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "schemas", "unused.sql"), "select 2;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(
          fs,
          path,
          workdir,
          [],
          pgDelta({ enabled: true }),
        );
        expect(result).toEqual(["supabase/database/t.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "prefers db.migrations.schema_paths over both the pg-delta dir and supabase/schemas",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "custom"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "custom", "x.sql"), "select 1;\n");
      mkdirSync(join(workdir, "supabase", "database"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "database", "unused.sql"), "select 2;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(
          fs,
          path,
          workdir,
          ["custom/*.sql"],
          pgDelta({ enabled: true }),
        );
        expect(result).toEqual(["supabase/custom/x.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect("fails when a literal (non-glob) schema_paths entry matches nothing", () => {
    const workdir = makeWorkdir();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const exit = yield* legacyLoadDeclaredSchemas(
        fs,
        path,
        workdir,
        ["missing.sql"],
        pgDelta(),
      ).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      rmSync(workdir, { recursive: true, force: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect(
    'an empty schema_paths entry matches nothing, not the entire project (Go\'s fs.Glob(""))',
    () => {
      // Go's `io/fs.Glob` never matches an empty pattern — its literal-pattern branch calls
      // `Stat(fsys, "")`, which fails on a real OS filesystem, so `Glob.SQLFiles` reports
      // `no files matched pattern: ` for it (verified empirically against the real
      // `config.Glob.SQLFiles` fed `""` over an `afero.NewOsFs()`). Without this guard,
      // `legacyGlobPattern`'s literal-pattern branch resolves `""` to the workdir itself
      // (which always exists) and recursively collects every `.sql` file in the project,
      // including files well outside any declared schema path.
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "migrations"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "migrations", "001_init.sql"), "select 1;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* legacyLoadDeclaredSchemas(fs, path, workdir, [""], pgDelta()).pipe(
          Effect.exit,
        );
        expect(exit._tag).toBe("Failure");
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect("a glob schema_paths entry matching nothing is silently skipped, not an error", () => {
    const workdir = makeWorkdir();
    mkdirSync(join(workdir, "supabase", "custom"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "custom", "x.sql"), "select 1;\n");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const result = yield* legacyLoadDeclaredSchemas(
        fs,
        path,
        workdir,
        ["custom/*.sql", "empty-glob/*.sql"],
        pgDelta(),
      );
      expect(result).toEqual(["supabase/custom/x.sql"]);
      rmSync(workdir, { recursive: true, force: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect(
    "normalizes a backslash-separated schema_paths entry before globbing (Go's filepath.ToSlash)",
    () => {
      // Go calls `fs.Glob(fsys, filepath.ToSlash(pattern))` immediately before globbing
      // (`pkg/config/config.go:145`) — a pattern containing `\` (as every absolute Windows
      // `schema_paths` entry does) must be forward-slashed first, or `legacyPathMatch`/
      // `legacyGlobPattern` (which only recognize `/` as a segment separator, and treat `\`
      // as a glob escape) mis-parse it entirely.
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "custom"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "custom", "x.sql"), "select 1;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(
          fs,
          path,
          workdir,
          ["custom\\x.sql"],
          pgDelta(),
        );
        expect(result).toEqual(["supabase/custom/x.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "excludes a symlinked .sql file from a recursively-matched schema_paths directory",
    () => {
      // Go's `entry.Type().IsRegular()` (`config.go:127`) is a no-follow check — a symlink
      // is never "regular", so `walkMatchedDir` excludes it even when it resolves to a real
      // `.sql` file.
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "custom"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "custom", "real.sql"), "select 1;\n");
      const secretTarget = join(workdir, "outside.sql");
      writeFileSync(secretTarget, "select 2;\n");
      symlinkSync(secretTarget, join(workdir, "supabase", "custom", "linked.sql"));
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(fs, path, workdir, ["custom"], pgDelta());
        expect(result).toEqual(["supabase/custom/real.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect("excludes a symlinked .sql file from the supabase/schemas fallback walk", () => {
    const workdir = makeWorkdir();
    mkdirSync(join(workdir, "supabase", "schemas"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "schemas", "real.sql"), "select 1;\n");
    const secretTarget = join(workdir, "outside.sql");
    writeFileSync(secretTarget, "select 2;\n");
    symlinkSync(secretTarget, join(workdir, "supabase", "schemas", "linked.sql"));
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const result = yield* legacyLoadDeclaredSchemas(fs, path, workdir, [], pgDelta());
      expect(result).toEqual(["supabase/schemas/real.sql"]);
      rmSync(workdir, { recursive: true, force: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect(
    "does not follow a symlinked subdirectory in a recursively-matched schema_paths directory",
    () => {
      // Go's `fs.WalkDir` (`walkMatchedDir`, `config.go:194-211`) is `Lstat`-based and never
      // descends into a symlinked directory (`io/fs.WalkDir` doc: "WalkDir does not follow
      // symbolic links found in directories") — a schema dir symlinking OUT of the configured
      // schema tree must not leak the linked directory's files into the diff/pull target.
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "custom"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "custom", "real.sql"), "select 1;\n");
      const outsideDir = join(workdir, "outside");
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, "secret.sql"), "select 2;\n");
      symlinkSync(outsideDir, join(workdir, "supabase", "custom", "linked-dir"), "dir");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(fs, path, workdir, ["custom"], pgDelta());
        expect(result).toEqual(["supabase/custom/real.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "does not follow a symlinked subdirectory in the supabase/schemas fallback walk",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "schemas"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "schemas", "real.sql"), "select 1;\n");
      const outsideDir = join(workdir, "outside");
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, "secret.sql"), "select 2;\n");
      symlinkSync(outsideDir, join(workdir, "supabase", "schemas", "linked-dir"), "dir");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(fs, path, workdir, [], pgDelta());
        expect(result).toEqual(["supabase/schemas/real.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "falls back to supabase/schemas when the pg-delta declarative path exists but is a regular file",
    () => {
      // Go's `afero.DirExists` (`apps/cli-go/internal/db/diff/diff.go:63`) treats a non-directory
      // path as absent, not present-but-unwalkable — a stray `supabase/database` FILE (e.g. left
      // over from a previous config) must fall through to `supabase/schemas`, not make
      // `legacyWalkSqlFilesSorted` try (and fail) to read a file as a directory.
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "database"), "not a directory");
      mkdirSync(join(workdir, "supabase", "schemas"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "schemas", "a.sql"), "select 1;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(
          fs,
          path,
          workdir,
          [],
          pgDelta({ enabled: true }),
        );
        expect(result).toEqual(["supabase/schemas/a.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "returns [] when supabase/schemas exists but is a regular file, not a directory",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "schemas"), "not a directory");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(fs, path, workdir, [], pgDelta());
        expect(result).toEqual([]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "returns [] (does not follow) when the pg-delta declarative dir itself is a symlink",
    () => {
      // Go's `afero.Walk(fsys, declDir, ...)` Lstat's the ROOT before ever calling `walkFn`
      // (`afero`'s own `Walk`/`lstatIfPossible`) — a symlinked root is treated as a
      // non-directory and produces zero files, silently, never descending into the target.
      // The PRECEDING `afero.DirExists`-equivalent existence check (which follows symlinks,
      // matching Go's own `fs.Stat`-based `DirExists`) reports the symlinked dir as present, so
      // only the WALK itself (not the existence check) must reject it.
      const workdir = makeWorkdir();
      const realDir = join(workdir, "real-database");
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, "t.sql"), "select 1;\n");
      mkdirSync(join(workdir, "supabase"), { recursive: true });
      symlinkSync(realDir, join(workdir, "supabase", "database"), "dir");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(
          fs,
          path,
          workdir,
          [],
          pgDelta({ enabled: true }),
        );
        expect(result).toEqual([]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect("returns [] (does not follow) when supabase/schemas itself is a symlink", () => {
    const workdir = makeWorkdir();
    const realDir = join(workdir, "real-schemas");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "t.sql"), "select 1;\n");
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    symlinkSync(realDir, join(workdir, "supabase", "schemas"), "dir");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const result = yield* legacyLoadDeclaredSchemas(fs, path, workdir, [], pgDelta());
      expect(result).toEqual([]);
      rmSync(workdir, { recursive: true, force: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect(
    "sorts declared schema paths by UTF-8 byte order, not JS's default UTF-16 code-unit order",
    () => {
      // A supplementary-plane character (U+1F600, a surrogate pair in UTF-16) alongside a BMP
      // private-use character (U+E000) is the textbook case where JS's default `.sort()`
      // (UTF-16 code units) disagrees with Go's `sort.Strings` (UTF-8 bytes, which preserves
      // codepoint order): JS ranks the surrogate pair first (0xD800 < 0xE000), Go ranks the
      // supplementary-plane codepoint last (it's numerically > U+FFFF). Verified empirically
      // against `Buffer.compare` on the two filenames' UTF-8 encodings.
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "schemas"), { recursive: true });
      const supplementary = "a\u{1F600}.sql";
      const privateUse = "a.sql";
      writeFileSync(join(workdir, "supabase", "schemas", supplementary), "select 1;\n");
      writeFileSync(join(workdir, "supabase", "schemas", privateUse), "select 2;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(fs, path, workdir, [], pgDelta());
        expect(result).toEqual([
          `supabase/schemas/${privateUse}`,
          `supabase/schemas/${supplementary}`,
        ]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "propagates (rather than silently drops) a per-entry stat failure during the pg-delta/schemas walk",
    () => {
      // Both Go walkers (`afero.Walk`, `fs.WalkDir`) pass a per-entry stat/lstat error to their
      // callback, which returns it and aborts the whole walk — an entry that can't be statted
      // after its parent was listed (permissions, I/O error, a concurrent filesystem change)
      // must not be silently omitted, which could build an incomplete declarative target.
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "schemas"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "schemas", "a.sql"), "select 1;\n");
      const brokenAbs = join(workdir, "supabase", "schemas", "broken.sql");
      writeFileSync(brokenAbs, "select 2;\n");
      const statFs = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (real) => ({
          ...real,
          stat: (statPath: string) =>
            statPath === brokenAbs
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "stat",
                    description: "simulated stat failure",
                    pathOrDescriptor: statPath,
                  }),
                )
              : real.stat(statPath),
        })),
      ).pipe(Layer.provideMerge(BunServices.layer));
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* legacyLoadDeclaredSchemas(fs, path, workdir, [], pgDelta()).pipe(
          Effect.exit,
        );
        expect(exit._tag).toBe("Failure");
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(statFs));
    },
  );

  it.effect.skipIf(isRoot)(
    "fails (rather than silently treating as empty) when a matched schema directory can't be read",
    () => {
      // Go's `walkMatchedDir` (`pkg/config/config.go:194-211`) propagates ANY `fs.WalkDir`
      // error as `failed to walk matched directory: <err>` — an unreadable directory must
      // surface as a failure, not silently contribute zero files (which could compare a
      // local-target diff against the wrong target or generate an incomplete migration).
      const workdir = makeWorkdir();
      const locked = join(workdir, "supabase", "locked");
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o000);
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* legacyLoadDeclaredSchemas(
          fs,
          path,
          workdir,
          ["locked"],
          pgDelta(),
        ).pipe(Effect.exit);
        expect(exit._tag).toBe("Failure");
        chmodSync(locked, 0o755);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );
});
