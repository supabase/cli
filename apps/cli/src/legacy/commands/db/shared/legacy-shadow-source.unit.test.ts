import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, Path, PlatformError } from "effect";

import { legacyCleanSchemaPath, legacyLoadDeclaredSchemas } from "./legacy-shadow-source.ts";
import type { LegacyPgDeltaTomlConfig } from "../../../shared/legacy-db-config.toml-read.ts";

function pgDelta(overrides: Partial<LegacyPgDeltaTomlConfig> = {}): LegacyPgDeltaTomlConfig {
  return {
    enabled: false,
    declarativeSchemaPath: Option.none(),
    formatOptions: Option.none(),
    ...overrides,
  };
}

function makeWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "legacy-shadow-source-"));
}

// Root bypasses POSIX permission bits, so chmod 000 wouldn't block readdir() there.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("legacyCleanSchemaPath", () => {
  // Go's `filepath.Clean` (windows build) never cleans INTO a leading UNC volume — verified
  // empirically against a standalone extraction of Go's own windows `internal/filepathlite`
  // Clean/ToSlash/volumeNameLen source, run natively: `filepath.ToSlash(filepath.Clean(
  // \`\\server\share\schemas\`))` compiled for `GOOS=windows` returns `//server/share/schemas`
  // (review: PRRT_kwDOErm0O86W2tRk) — the doubled leading separator is part of the UNC host+
  // share, not a redundant separator to collapse to one.
  it("preserves a UNC host+share prefix on win32, matching Go's Clean", () => {
    expect(legacyCleanSchemaPath("\\\\server\\share\\schemas", "win32")).toBe(
      "//server/share/schemas",
    );
  });

  it("cleans `.`/`..` segments AFTER a UNC prefix without touching the prefix itself", () => {
    expect(legacyCleanSchemaPath("\\\\server\\share\\a\\.\\b\\..\\c", "win32")).toBe(
      "//server/share/a/c",
    );
  });

  it("drops a leading `..` past a UNC share root instead of climbing above it", () => {
    expect(legacyCleanSchemaPath("\\\\server\\share\\..\\schemas", "win32")).toBe(
      "//server/share/schemas",
    );
  });

  it("leaves a bare UNC share (no subpath) unchanged", () => {
    expect(legacyCleanSchemaPath("\\\\server\\share", "win32")).toBe("//server/share");
  });

  it("does not confuse a UNC path with the distinct root-relative path of the same tail", () => {
    // The bug this guards against: collapsing `//server/share/schemas` down to
    // `/server/share/schemas` would make a UNC `schema_paths` entry compare equal to an
    // unrelated root-relative declarative dir.
    expect(legacyCleanSchemaPath("\\\\server\\share\\schemas", "win32")).not.toBe(
      legacyCleanSchemaPath("/server/share/schemas", "win32"),
    );
  });

  it("still cleans a drive-letter path correctly", () => {
    expect(legacyCleanSchemaPath("C:\\foo\\..\\bar", "win32")).toBe("C:/bar");
  });

  it("does not treat a doubled separator as a UNC volume off win32", () => {
    // POSIX has no UNC concept — Go's non-Windows `filepath.Clean` collapses redundant
    // separators uniformly, same as this function's pre-existing POSIX behavior.
    expect(legacyCleanSchemaPath("//server/share/schemas", "darwin")).toBe("/server/share/schemas");
  });
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
          pgDelta({
            enabled: true,
            declarativeSchemaPath: Option.some("supabase/database"),
          }),
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
          pgDelta({
            enabled: true,
            declarativeSchemaPath: Option.some("supabase/database"),
          }),
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
    "on POSIX, a backslash in a schema_paths entry is a path.Match escape, not a separator (review: PRRT_kwDOErm0O86W7n90)",
    () => {
      // Go's `filepath.ToSlash` (`fs.Glob(fsys, filepath.ToSlash(pattern))`,
      // `pkg/config/config.go:145`) is a byte-for-byte no-op on POSIX — only Windows's
      // `filepath.Separator` is `\`. `path.Match` (what `fs.Glob` compiles down to) then
      // treats an un-converted `\` as an escape metacharacter: `custom\x.sql` escapes the
      // literal `x`, matching a FILE literally named `customx.sql` directly under
      // `supabase/`, never the path-separated `supabase/custom/x.sql`. Verified empirically:
      // `path.Match("custom\\x.sql", "customx.sql")` is `true` on darwin, while
      // `path.Match("custom\\x.sql", "custom/x.sql")` never even reaches that filename (the
      // pattern has no `/`, so it only lists `supabase/`, never descends into `custom/`).
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "customx.sql"), "select 1;\n");
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
        expect(result).toEqual(["supabase/customx.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "on POSIX, a backslash-escaped glob metacharacter in schema_paths matches the literal filename (review: PRRT_kwDOErm0O86W7n90)",
    () => {
      // The specific case the review thread flagged: `path.Match("foo\\*.sql", "foo*.sql")`
      // is `true` on darwin — the escaped `*` is a literal asterisk, matching a file named
      // `foo*.sql`, not a glob that searches a `foo/` subdirectory. Before this fix,
      // `legacyGlobDeclaredSchemaPaths` unconditionally rewrote the pattern to `foo/*.sql`
      // ahead of globbing, which searches `foo/` instead and would report "no files matched"
      // for this exact, valid Go config.
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "foo*.sql"), "select 1;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(
          fs,
          path,
          workdir,
          ["foo\\*.sql"],
          pgDelta(),
        );
        expect(result).toEqual(["supabase/foo*.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "dedupes a directory schema_paths entry with a trailing separator against a literal-file entry for the same file (review: PRRT_kwDOErm0O86XAlIr)",
    () => {
      // A RELATIVE trailing-slash entry gets `path.Join`-cleaned away by
      // `legacyResolveSeedSqlPath` before it ever reaches the glob, matching Go's own
      // `path.Join(builder.SupabaseDirPath, pattern)` resolution — so the bug is only
      // reachable via an ABSOLUTE entry, which `legacyResolveSeedSqlPath` returns verbatim
      // (Go's `Glob.files` never resolves an absolute entry either). Without the fix, the
      // directory branch recorded the walked file as `<abs>/custom//x.sql` (raw template
      // concatenation), which never matches the literal entry's `<abs>/custom/x.sql` in
      // `seen`, so both were appended to `result` and the declarative apply would run the
      // same file's SQL twice.
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "custom"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "custom", "x.sql"), "select 1;\n");
      const absDirWithTrailingSlash = `${join(workdir, "supabase", "custom")}/`;
      const absFile = join(workdir, "supabase", "custom", "x.sql");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacyLoadDeclaredSchemas(
          fs,
          path,
          workdir,
          [absDirWithTrailingSlash, absFile],
          pgDelta(),
        );
        expect(result).toEqual([absFile]);
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
          pgDelta({
            enabled: true,
            declarativeSchemaPath: Option.some("supabase/database"),
          }),
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
          pgDelta({
            enabled: true,
            declarativeSchemaPath: Option.some("supabase/database"),
          }),
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
    "fails (rather than silently treating as empty) when a matched schema directory can't be read, and keeps the underlying cause in the message",
    () => {
      // Go's `walkMatchedDir` (`pkg/config/config.go:194-211`) propagates ANY `fs.WalkDir`
      // error as `failed to walk matched directory: <err>` — an unreadable directory must
      // surface as a failure, not silently contribute zero files (which could compare a
      // local-target diff against the wrong target or generate an incomplete migration), and
      // the reported message must carry the real underlying error (permission denied, here),
      // not just the directory name — otherwise a user can't tell WHY the walk failed.
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
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = JSON.stringify(exit.cause);
          expect(errorJson).toContain("failed to walk matched directory:");
          expect(errorJson).not.toContain("failed to walk matched directory: locked");
        }
        chmodSync(locked, 0o755);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect.skipIf(isRoot)(
    "visits sibling directories in UTF-8 byte order, not JS's default UTF-16 order, so the reported failure matches Go's (review: PRRT_kwDOErm0O86XAlIo)",
    () => {
      // `["dir\u{1F600}", "dir\u{E000}"].sort()` (JS default, UTF-16 code-unit order) puts the
      // supplementary-plane name FIRST — its lead surrogate (0xD83D) is less than the
      // private-use code unit (0xE000). Byte order (Go's `sort.Strings`/`bytealg.CompareString`,
      // what `legacyCompareUtf8Bytes` reproduces) disagrees: U+1F600 encodes to a LARGER first
      // UTF-8 byte (0xF0) than U+E000 (0xEE), so the private-use name sorts first instead.
      // Both subdirectories are unreadable, so whichever the walk visits FIRST is the one whose
      // `EACCES` failure aborts the whole walk (Effect.gen never reaches the second entry) —
      // its path, not the other one's, must appear in the resulting error.
      const workdir = makeWorkdir();
      const matched = join(workdir, "supabase", "custom");
      const utf16First = join(matched, "dir\u{1F600}");
      const byteOrderFirst = join(matched, "dir\u{E000}");
      mkdirSync(utf16First, { recursive: true });
      mkdirSync(byteOrderFirst, { recursive: true });
      chmodSync(utf16First, 0o000);
      chmodSync(byteOrderFirst, 0o000);
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* legacyLoadDeclaredSchemas(
          fs,
          path,
          workdir,
          ["custom"],
          pgDelta(),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = JSON.stringify(exit.cause);
          expect(errorJson).toContain(byteOrderFirst);
          expect(errorJson).not.toContain(utf16First);
        }
        chmodSync(utf16First, 0o755);
        chmodSync(byteOrderFirst, 0o755);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect.skipIf(isRoot)(
    "reports the pg-delta declarative dir walk failure as 'failed to walk declarative dir', not the generic 'failed to walk dir'",
    () => {
      // Go's `loadDeclaredSchemas` (`apps/cli-go/internal/db/diff/diff.go:52-101`) wraps the
      // SAME `afero.Walk` failure with a DIFFERENT prefix per source: the pg-delta declarative
      // dir branch reports `failed to walk declarative dir: %w`, while the `supabase/schemas`
      // fallback (covered by the sibling test below) reports `failed to walk dir: %w` — both
      // walks share `legacyWalkSqlFilesSorted`, which must be told which source it's walking.
      const workdir = makeWorkdir();
      const declDir = join(workdir, "supabase", "database");
      mkdirSync(declDir, { recursive: true });
      chmodSync(declDir, 0o000);
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* legacyLoadDeclaredSchemas(
          fs,
          path,
          workdir,
          [],
          pgDelta({
            enabled: true,
            declarativeSchemaPath: Option.some("supabase/database"),
          }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = JSON.stringify(exit.cause);
          expect(errorJson).toContain("failed to walk declarative dir:");
          expect(errorJson).not.toContain("failed to walk dir:");
        }
        chmodSync(declDir, 0o755);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect.skipIf(isRoot)(
    "reports the supabase/schemas fallback walk failure as 'failed to walk dir', not the declarative-dir prefix",
    () => {
      const workdir = makeWorkdir();
      const schemasDir = join(workdir, "supabase", "schemas");
      mkdirSync(schemasDir, { recursive: true });
      chmodSync(schemasDir, 0o000);
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* legacyLoadDeclaredSchemas(fs, path, workdir, [], pgDelta()).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = JSON.stringify(exit.cause);
          expect(errorJson).toContain("failed to walk dir:");
          expect(errorJson).not.toContain("failed to walk declarative dir:");
        }
        chmodSync(schemasDir, 0o755);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );
});
