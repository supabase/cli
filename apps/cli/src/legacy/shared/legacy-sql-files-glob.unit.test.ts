import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath, BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { legacySqlFilesGlob } from "./legacy-sql-files-glob.ts";

const run = (patterns: ReadonlyArray<string>, workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacySqlFilesGlob(fs, path, patterns, workdir);
  }).pipe(Effect.provide(BunServices.layer));

describe("legacySqlFilesGlob", () => {
  it.effect(
    "treats an empty pattern as no match, not the workdir itself (Go fs.Glob parity)",
    () => {
      // Go's `fs.Glob`/`afero.Glob` resolve a no-metacharacter pattern via `Lstat`, which
      // errors on an empty path — an empty `schema_paths`/`sql_paths` entry (e.g.
      // `schema_paths = [""]`) always yields no matches, never the workdir itself.
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-empty-"));
      return run([""], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual([]);
            expect(result.warnings).toEqual(["no files matched pattern: "]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "does not follow a symlinked .sql file below a matched directory (Go WalkDir parity)",
    () => {
      // Go's `Glob.SQLFiles` expands a matched directory with `fs.WalkDir`, which types
      // each child from its parent's `ReadDir` entry (`os.ReadDir`'s Lstat-based
      // `DirEntry`) and never re-`Stat`s through it — so a symlinked `.sql` file is
      // never included, regardless of what it points to.
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-symlink-file-"));
      const schemasDir = join(dir, "schemas");
      mkdirSync(schemasDir);
      writeFileSync(join(schemasDir, "real.sql"), "select 1;");
      const outsideDir = join(dir, "outside");
      mkdirSync(outsideDir);
      writeFileSync(join(outsideDir, "evil.sql"), "select 2;");
      symlinkSync(join(outsideDir, "evil.sql"), join(schemasDir, "linked.sql"));
      return run(["schemas"], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual(["schemas/real.sql"]);
            expect(result.warnings).toEqual([]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "does not recurse into a symlinked subdirectory below a matched directory (Go WalkDir parity)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-symlink-dir-"));
      const schemasDir = join(dir, "schemas");
      mkdirSync(schemasDir);
      writeFileSync(join(schemasDir, "real.sql"), "select 1;");
      const outsideSubdir = join(dir, "outside-subdir");
      mkdirSync(outsideSubdir);
      writeFileSync(join(outsideSubdir, "nested.sql"), "select 3;");
      symlinkSync(outsideSubdir, join(schemasDir, "linked-dir"));
      return run(["schemas"], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual(["schemas/real.sql"]);
            expect(result.warnings).toEqual([]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "surfaces a stat failure on a matched file as a warning instead of treating it as a regular file (Go parity)",
    () => {
      // Go: `if info, err := fs.Stat(fsys, fp); err != nil { allErrors = append(allErrors,
      // errors.Errorf("failed to stat matched file: %w", err)); continue }` (config.go:157-161)
      // — a match that disappears (or is a broken symlink) between the glob and this stat
      // becomes a warning and is skipped entirely, never silently treated as a regular file.
      //
      // Go's `fsys` here is always `afero.NewOsFs()` with the process cwd already the
      // workdir (`ChangeWorkDir`, `cmd/root.go`), so `fs.Stat(fsys, fp)`'s embedded path
      // in the resulting error is the workdir-RELATIVE `fp` (verified directly against
      // `os.Stat`/`afero.OsFs.Stat`, which pass the name through to `os.Stat` unchanged).
      // This module never `process.chdir`s, so the real stat needs an absolute path — but
      // the warning must still report the relative form, not that absolute (temp-dir)
      // path, or it would leak a local filesystem path Go never would.
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-stat-fail-"));
      const schemasDir = join(dir, "schemas");
      mkdirSync(schemasDir);
      writeFileSync(join(schemasDir, "good.sql"), "select 1;");
      symlinkSync(join(schemasDir, "does-not-exist.sql"), join(schemasDir, "broken.sql"));
      return run(["schemas/*.sql"], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual(["schemas/good.sql"]);
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toMatch(/^failed to stat matched file: /);
            expect(result.warnings[0]).toContain("schemas/broken.sql");
            expect(result.warnings[0]).not.toContain(dir);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "keeps a bare root ('/') as the directory when a glob pattern's meta character is in the first path component (Go afero.Glob parity)",
    () => {
      // Go's real runtime glob path — `config.Glob.SQLFiles`'s `fs.Glob` call resolves to
      // `afero.IOFS.Glob` (it implements `fs.GlobFS`), which delegates to `afero.Glob`
      // (`match.go`): `filepath.Split` followed by a switch that leaves a bare
      // `filepath.Separator` alone — every OTHER trailing separator is chopped, but the
      // root one is deliberately preserved. Verified empirically against `apps/cli-go`:
      // with cwd elsewhere, a pattern rooted at "/" with a metacharacter in the first
      // component after the root slash still resolves against the filesystem ROOT, not
      // cwd. A canary file placed in the WORKDIR (never the real "/") proves this native
      // port does not fall back to treating the root component as workdir-relative.
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-abs-root-"));
      writeFileSync(join(dir, "__legacy_sql_glob_canary__.sql"), "select 1;");
      return run(["/*__legacy_sql_glob_canary__*.sql"], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual([]);
            expect(result.warnings).toEqual([
              "no files matched pattern: /*__legacy_sql_glob_canary__*.sql",
            ]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "recurses through a root-anchored directory component without falling back to the workdir (Go afero.Glob parity)",
    () => {
      // Same bug as above, but for a two-level pattern (`/foo*/*.sql`) — the recursive
      // call that resolves the "foo*" directory component must also treat "/" as the
      // real filesystem root, not "" (which `globOne` maps to the workdir). The workdir
      // here contains a subdirectory that WOULD match "foo*" if (and only if) the
      // recursive call incorrectly fell back to reading the workdir instead of "/".
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-abs-root-nested-"));
      const canaryDir = join(dir, "__legacy_sql_glob_root_canary_dir__");
      mkdirSync(canaryDir);
      writeFileSync(join(canaryDir, "a.sql"), "select 1;");
      return run(["/__legacy_sql_glob_root_canary_dir__*/*.sql"], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual([]);
            expect(result.warnings).toEqual([
              "no files matched pattern: /__legacy_sql_glob_root_canary_dir__*/*.sql",
            ]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "preserves a Windows drive root ('C:/') as the directory when splitting a glob pattern (Go filepath.Split parity)",
    () => {
      // Go's `filepath.Split` treats `"C:"` as the volume name on Windows
      // (`volumeNameLen`, `internal/filepathlite/path_windows.go`) and always
      // keeps the following separator attached to `dir` — so `Split("C:/*.sql")`
      // returns `dir: "C:/"`, not `dir: "C:"` (verified directly against that
      // stdlib source; there is no Windows machine available to run the
      // compiled binary on). Losing the trailing slash matters: Node's
      // `path.isAbsolute("C:")` is `false` (a bare drive letter is
      // *drive-relative*, not absolute, in Windows semantics), so `globOne`'s
      // `resolve()` would wrongly `join` it under the workdir instead of
      // resolving the real drive root. Force win32 path semantics
      // (`BunPath.layerWin32`) and this module's own `process.platform` gate
      // so the test exercises the same branch a real Windows install takes.
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-drive-root-"));
      writeFileSync(join(dir, "a.sql"), "select 1;");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // A "C:/" drive root doesn't exist on this (non-Windows) test host, so
        // fake just the two calls that must resolve against it, reusing a real
        // file's stat info to avoid hand-rolling a `File.Info`.
        const realFileInfo = yield* fs.stat(join(dir, "a.sql"));
        const driveRootFs: FileSystem.FileSystem = {
          ...fs,
          readDirectory: (p: string) =>
            p === "C:/" ? Effect.succeed(["a.sql"]) : fs.readDirectory(p),
          stat: (p: string) => (p === "C:/a.sql" ? Effect.succeed(realFileInfo) : fs.stat(p)),
        };
        return yield* legacySqlFilesGlob(driveRootFs, path, ["C:/*.sql"], dir);
      }).pipe(
        Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layerWin32)),
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual(["C:/a.sql"]);
            expect(result.warnings).toEqual([]);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            Object.defineProperty(process, "platform", { value: originalPlatform });
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "reports the raw backslash pattern in a 'no files matched' warning on Windows, not the slashed form used for matching (Go filepath.ToSlash parity)",
    () => {
      // Go passes `filepath.ToSlash(pattern)` only as an ARGUMENT to `fs.Glob`
      // (`config.go:145`) — the loop's own `pattern` variable (Go's range variable) is
      // never reassigned, so the "no files matched pattern: %s" warning (`config.go:155`)
      // still reports the ORIGINAL backslash form. An absolute Windows pattern with
      // backslashes that matches nothing must therefore warn with that backslash form,
      // not the slashed one used internally to glob. Force win32 path semantics
      // (`BunPath.layerWin32`) and this module's own `process.platform` gate, same as
      // the drive-root test above.
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-win-warn-"));
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        return yield* legacySqlFilesGlob(fs, path, ["C:\\schemas\\*.sql"], dir);
      }).pipe(
        Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layerWin32)),
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual([]);
            expect(result.warnings).toEqual(["no files matched pattern: C:\\schemas\\*.sql"]);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            Object.defineProperty(process, "platform", { value: originalPlatform });
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "sorts raw backslash-joined Windows matches BEFORE slashing, not after (Go afero.Glob/filepath.ToSlash ordering parity)",
    () => {
      // Go's `config.Glob.SQLFiles` (`config.go:145-156`) calls `fs.Glob`, which resolves
      // to `afero.Glob`'s `glob()` helper — it builds each match with `filepath.Join(dir,
      // n)` (OS-separator-joined, backslash on Windows) and NEVER slashes it. Only back in
      // `SQLFiles`, AFTER `sort.Strings(matches)` sorts those raw backslash matches, does
      // each surviving item get `filepath.ToSlash`'d. For a pattern like `a*/x.sql`
      // matching both `a\x.sql` and `a0\x.sql`, sorting the RAW backslash strings byte-for
      // -byte puts `a0\x.sql` first (`\` is `0x5C`, greater than `0`'s `0x30`) — but
      // sorting the SLASHED strings instead would put `a/x.sql` first (`/` is `0x2F`, less
      // than `0x30`), a different order for the same two matches. `globOne` must therefore
      // push the raw joined match (slashing only happens in the caller's post-sort loop),
      // matching Go's real order exactly. Fully faked filesystem (no real Windows host
      // available): `readDirectory`/`stat` return canned results keyed by the exact
      // backslash-joined paths `BunPath.layerWin32`'s `path.join` computes.
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      const scratchDir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-win-sort-"));
      const canaryFile = join(scratchDir, "canary.sql");
      writeFileSync(canaryFile, "select 1;");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fileInfo = yield* fs.stat(canaryFile);
        const workdir = "/workdir";
        const winFs: FileSystem.FileSystem = {
          ...fs,
          readDirectory: (p: string) => {
            if (p === workdir) return Effect.succeed(["a", "a0"]);
            if (p === "\\workdir\\a" || p === "\\workdir\\a0") return Effect.succeed(["x.sql"]);
            return fs.readDirectory(p);
          },
          stat: (p: string) =>
            p === "\\workdir\\a\\x.sql" || p === "\\workdir\\a0\\x.sql"
              ? Effect.succeed(fileInfo)
              : fs.stat(p),
        };
        return yield* legacySqlFilesGlob(winFs, path, ["a*/x.sql"], workdir);
      }).pipe(
        Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layerWin32)),
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual(["a0/x.sql", "a/x.sql"]);
            expect(result.warnings).toEqual([]);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            Object.defineProperty(process, "platform", { value: originalPlatform });
            rmSync(scratchDir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "normalizes a doubled slash when the matched directory itself has a trailing slash (Go path.Join parity)",
    () => {
      // Go's `fs.WalkDir` builds each child path via `path.Join(dirname, name)`
      // (`io/fs/walk.go`), and `path.Join` runs `path.Clean` on the result, collapsing a
      // doubled `/`. A literal (no-metacharacter) `schema_paths`/`sql_paths` entry like
      // `"schemas/"` resolves via `fs.Glob`'s fast path to the pattern VERBATIM, trailing
      // slash and all — so the walk over its children must not produce `schemas//a.sql`.
      // Verified empirically against `apps/cli-go`: a scratch probe calling
      // `config.Glob{"<dir>/"}.SQLFiles(...)` on a real trailing-slash directory returns
      // the single-slash path, not a doubled one.
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-trailing-slash-"));
      const schemasDir = join(dir, "schemas");
      mkdirSync(schemasDir);
      writeFileSync(join(schemasDir, "a.sql"), "select 1;");
      return run(["schemas/"], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual(["schemas/a.sql"]);
            expect(result.warnings).toEqual([]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "drops the './' prefix when the matched directory cleans to '.' (Go path.Join parity)",
    () => {
      // Go's `fs.WalkDir` builds each child path via `path.Join(dirname, name)`, and
      // `path.Join` runs `path.Clean`, which drops a bare `.` root entirely rather than
      // joining it as a prefix. A matched directory can clean to exactly `.` — e.g.
      // `[db.migrations].schema_paths = [".."]`/`[db.seed].sql_paths = [".."]`, which
      // `baseConfig.resolve`'s own `path.Join(builder.SupabaseDirPath, pattern)` collapses
      // to `.` (`apps/cli-go/pkg/config/config.go:969-980`) — so the walk over its children
      // must record `a.sql`, not `./a.sql`. This matters beyond cosmetics: for seeds, the
      // walked path becomes the `supabase_migrations.seed_files.path` hash key, so a
      // `./`-prefixed path would never match an already-recorded Go-CLI key. Verified
      // empirically: `path.Join(".", "foo.sql")` and a real `fs.WalkDir` rooted at `.` both
      // drop the `./` prefix entirely.
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-dot-root-"));
      writeFileSync(join(dir, "a.sql"), "select 1;");
      const nestedDir = join(dir, "nested");
      mkdirSync(nestedDir);
      writeFileSync(join(nestedDir, "b.sql"), "select 2;");
      return run(["."], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual(["a.sql", "nested/b.sql"]);
            expect(result.warnings).toEqual([]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "cleans a '..'-segment matched directory when walking its children (Go path.Join parity)",
    () => {
      // Go's `fs.WalkDir` builds each child path via `path.Join(dirname, name)`, and
      // `path.Join` runs `path.Clean`, which lexically resolves an embedded `..` segment —
      // not just a bare `.` root or a trailing slash. A matched directory can contain a
      // `..` anywhere, e.g. `[db.migrations].schema_paths = ["nested/../schemas"]`, and the
      // walk over its children must record `schemas/a.sql`, not `nested/../schemas/a.sql`.
      // Verified empirically: `path.Join("/tmp/x/../schemas", "a.sql")` and Node's
      // `path.join("/tmp/x/../schemas", "a.sql")` both clean to `/tmp/schemas/a.sql`.
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-dotdot-segment-"));
      const schemasDir = join(dir, "schemas");
      mkdirSync(schemasDir);
      writeFileSync(join(schemasDir, "a.sql"), "select 1;");
      return run(["nested/../schemas"], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual(["schemas/a.sql"]);
            expect(result.warnings).toEqual([]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "cleans a direct glob match whose directory portion has a '.' segment (Go afero.Glob parity)",
    () => {
      // Distinct from the walked-child cleaning above: this pattern's glob metacharacter
      // (`*`) is in the FINAL component, so `globOne` matches `a.sql` directly against
      // the directory entries of `schemas/.` — it never goes through
      // `legacyWalkSqlFiles`. Go's real runtime glob path resolves through
      // `afero.IOFS.Glob` -> `afero.Glob`'s `glob()` helper, which appends each match as
      // `filepath.Join(dir, n)` (`match.go:99`) — so the recorded match is the CLEANED
      // `schemas/a.sql`, not a raw `schemas/./a.sql` concatenation. Verified empirically:
      // a scratch `afero.Glob(fs, ".../tmp/./schemas/*.sql")` probe against a real
      // filesystem returns the cleaned path.
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-direct-dot-segment-"));
      const schemasDir = join(dir, "schemas");
      mkdirSync(schemasDir);
      writeFileSync(join(schemasDir, "a.sql"), "select 1;");
      return run(["schemas/./*.sql"], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual(["schemas/a.sql"]);
            expect(result.warnings).toEqual([]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "cleans a direct glob match whose directory portion has a '..' segment (Go afero.Glob parity)",
    () => {
      // Same distinction as above (a direct match via `globOne`, not a walked directory
      // expansion), but for an embedded `..` rather than a `.` segment — e.g. an absolute
      // `schema_paths`/`sql_paths` entry like `/tmp/x/../schemas/*.sql`. `filepath.Join`
      // lexically resolves `..` the same way it drops a bare `.` root, so Go still records
      // the cleaned `schemas/a.sql`, not `nested/../schemas/a.sql`. For seed files, that
      // recorded path is the `supabase_migrations.seed_files.path` hash key, so leaving it
      // uncleaned would make a TS-resolved match fail to line up with an already-recorded
      // Go-CLI key and re-run/re-record the seed.
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-direct-dotdot-segment-"));
      const schemasDir = join(dir, "schemas");
      mkdirSync(schemasDir);
      writeFileSync(join(schemasDir, "a.sql"), "select 1;");
      return run(["nested/../schemas/*.sql"], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual(["schemas/a.sql"]);
            expect(result.warnings).toEqual([]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "normalizes a doubled slash for a direct glob match under a trailing-slash directory component (Go afero.Glob parity)",
    () => {
      // Same distinction again: `splitPath` on `"schemas//*.sql"` yields a `dir` of
      // `"schemas/"` (a single trailing slash survives the split), so the old raw
      // `` `${d}/${name}` `` concatenation inserted a SECOND slash on top of it
      // (`"schemas//a.sql"`). `filepath.Join`/`path.join` collapse doubled slashes
      // regardless of where they came from, so the recorded match must be the
      // single-slash `schemas/a.sql`.
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-direct-doubled-slash-"));
      const schemasDir = join(dir, "schemas");
      mkdirSync(schemasDir);
      writeFileSync(join(schemasDir, "a.sql"), "select 1;");
      return run(["schemas//*.sql"], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual(["schemas/a.sql"]);
            expect(result.warnings).toEqual([]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "still includes a '.sql' child whose stat fails after it's already listed (Go WalkDir parity)",
    () => {
      // Go's `fs.WalkDir` types each child from the parent's `ReadDir`-returned `DirEntry`
      // and never re-`Stat`s through it, so a `.sql` file that disappears between `ReadDir`
      // and its own visit stays in Go's declared file list — only the later, real file-open
      // fails. Simulate the stat failure directly (mocking a real race is flaky) by pointing
      // the matched directory at one that lists a child but whose child path is unreadable:
      // a broken symlink target used as a bare filename via a `readLink` failure isn't
      // enough here (that's the earlier symlink test), so exercise the `fs.stat` failure
      // path itself by removing the file the instant after `readDirectory` returns it, via
      // a `FileSystem` layer that deletes on first `stat` call for that path.
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-stat-race-"));
      const schemasDir = join(dir, "schemas");
      mkdirSync(schemasDir);
      const racyFile = join(schemasDir, "racy.sql");
      writeFileSync(racyFile, "select 1;");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const racyFs: FileSystem.FileSystem = {
          ...fs,
          stat: (p: string) =>
            p === racyFile
              ? Effect.sync(() => rmSync(racyFile)).pipe(Effect.andThen(fs.stat(p)))
              : fs.stat(p),
        };
        return yield* legacySqlFilesGlob(racyFs, path, ["schemas"], dir);
      }).pipe(
        Effect.provide(BunServices.layer),
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual(["schemas/racy.sql"]);
            expect(result.warnings).toEqual([]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "fails the whole walk when a non-'.sql' child whose stat fails could have been a subdirectory (Go WalkDir parity)",
    () => {
      // Round 6 (test above) established that a `.sql` FILE child racing away between
      // `readDirectory` and this port's own `stat` call is best-effort included, matching
      // Go's cached-`DirEntry` behaviour for regular files. But Go's `fs.WalkDir` does NOT
      // treat every vanished child the same way: for a DIRECTORY `DirEntry`, it unconditionally
      // attempts a second `ReadDir` to recurse into it; when that child is gone, the second
      // `ReadDir` fails, and `walkMatchedDir`'s callback propagates the error unchanged
      // (`if err != nil { return err }`, `config.go:198-199`) — `fs.WalkDir` returns it, and
      // `walkMatchedDir` wraps it as `failed to walk matched directory: <cause>`, discarding
      // every file already collected (`config.go:205-206`). Verified empirically with a
      // scratch `fs.WalkDir` probe against `apps/cli-go`'s real `walkMatchedDir`: removing a
      // nested subdirectory between the parent's `ReadDir` and the subdirectory's own `ReadDir`
      // reproduces exactly this — zero files, `failed to walk matched directory: open
      // .../nested: no such file or directory` — never a silent skip. This port's `stat` call
      // is a second, separate syscall from the parent's `readDirectory` (unlike Go, which gets
      // the child's type for free from the SAME syscall as the listing), so a raced
      // disappearance here always loses the type along with the entry — a non-`.sql` name
      // could equally have been the now-missing subdirectory, and must fail the same way an
      // unreadable still-present directory does, not silently vanish along with the files it
      // may have held.
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-dir-race-"));
      const schemasDir = join(dir, "schemas");
      mkdirSync(schemasDir);
      writeFileSync(join(schemasDir, "a.sql"), "select 1;");
      const nestedDir = join(schemasDir, "nested");
      mkdirSync(nestedDir);
      writeFileSync(join(nestedDir, "b.sql"), "select 2;");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const racyFs: FileSystem.FileSystem = {
          ...fs,
          stat: (p: string) =>
            p === nestedDir
              ? Effect.sync(() => rmSync(nestedDir, { recursive: true })).pipe(
                  Effect.andThen(fs.stat(p)),
                )
              : fs.stat(p),
        };
        return yield* legacySqlFilesGlob(racyFs, path, ["schemas"], dir);
      }).pipe(
        Effect.provide(BunServices.layer),
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual([]);
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toMatch(/^failed to walk matched directory: /);
            // This `stat` failure stands in for the second `ReadDir` Go's own `fs.WalkDir`
            // would issue on the vanished directory — whose error, like every other Go
            // filesystem error here, embeds the workdir-relative path, not this port's
            // absolute stand-in syscall path.
            expect(result.warnings[0]).toContain("schemas/nested");
            expect(result.warnings[0]).not.toContain(dir);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("still expands a real (non-symlinked) nested directory recursively", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-nested-"));
    const schemasDir = join(dir, "schemas");
    const nestedDir = join(schemasDir, "nested");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(schemasDir, "a.sql"), "select 1;");
    writeFileSync(join(nestedDir, "b.sql"), "select 2;");
    return run(["schemas"], dir).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.files).toEqual(["schemas/a.sql", "schemas/nested/b.sql"]);
          expect(result.warnings).toEqual([]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it.effect.skipIf(isRoot)(
    "surfaces a directory-read failure during walk as a warning instead of an empty match (Go WalkDir parity)",
    () => {
      // Go's `fs.WalkDir` returns the `ReadDir` error from its walkFn unchanged, which
      // stops the walk immediately; `walkMatchedDir` then wraps it as `failed to walk
      // matched directory: ...` and discards every file already found — never an empty
      // (successful) match. Verified empirically against `apps/cli-go`: an unreadable
      // matched directory makes `Glob.SQLFiles` return that error with zero files.
      //
      // Go's `fsys` here is always `afero.OsFs` with the process cwd already the workdir
      // (`ChangeWorkDir`, `cmd/root.go`), so the `ReadDir` error's embedded path is the
      // workdir-relative matched directory (`schemas`), never an absolute one. This
      // module never `process.chdir`s, so the real read needs an absolute path, but the
      // warning must still report the relative form.
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-walk-fail-"));
      const schemasDir = join(dir, "schemas");
      mkdirSync(schemasDir);
      writeFileSync(join(schemasDir, "a.sql"), "select 1;");
      chmodSync(schemasDir, 0o000);
      return run(["schemas"], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual([]);
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toMatch(/^failed to walk matched directory: /);
            expect(result.warnings[0]).toContain("schemas");
            expect(result.warnings[0]).not.toContain(dir);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            chmodSync(schemasDir, 0o755);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect.skipIf(isRoot)(
    "surfaces a NESTED directory-read failure during walk with a workdir-relative path, not the matched root's (Go WalkDir parity)",
    () => {
      // Same leak as the matched-root-directory case above, but for a failure during the
      // RECURSIVE walk of an already-descended subdirectory — a distinct code path inside
      // Go's `fs.WalkDir` callback (it recurses via the SAME `ReadDir` call the matched
      // root used, `io/fs/walk.go`), and this port's `walk()` closure recurses the same
      // way. The matched root ("schemas") itself is readable; only "schemas/nested" is
      // not, so the warning must report "schemas/nested", never the workdir's absolute
      // temp-dir path.
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-walk-fail-nested-"));
      const schemasDir = join(dir, "schemas");
      const nestedDir = join(schemasDir, "nested");
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(join(schemasDir, "a.sql"), "select 1;");
      writeFileSync(join(nestedDir, "b.sql"), "select 2;");
      chmodSync(nestedDir, 0o000);
      return run(["schemas"], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual([]);
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toMatch(/^failed to walk matched directory: /);
            expect(result.warnings[0]).toContain("schemas/nested");
            expect(result.warnings[0]).not.toContain(dir);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            chmodSync(nestedDir, 0o755);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect.skipIf(isRoot)(
    "keeps files from a sibling pattern when only one matched directory fails to walk",
    () => {
      // Go: `if err != nil { allErrors = append(allErrors, err); continue }` — a walk
      // failure on one match doesn't stop the loop over the REST of the matches/patterns;
      // whether it's ultimately fatal is the caller's decision (`legacyApplySchemaFiles`'s
      // `len(declared) == 0` gate), not this function's.
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-walk-fail-partial-"));
      const goodDir = join(dir, "good");
      const badDir = join(dir, "bad");
      mkdirSync(goodDir);
      mkdirSync(badDir);
      writeFileSync(join(goodDir, "a.sql"), "select 1;");
      writeFileSync(join(badDir, "b.sql"), "select 2;");
      chmodSync(badDir, 0o000);
      return run(["good", "bad"], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual(["good/a.sql"]);
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toMatch(/^failed to walk matched directory: /);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            chmodSync(badDir, 0o755);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "sorts direct wildcard matches by UTF-8 byte order, not UTF-16 code units (Go sort.Strings parity)",
    () => {
      // Go's `sort.Strings` (`Glob.SQLFiles`, `config.go:155`) orders the raw UTF-8 bytes
      // of each match. A supplementary-plane character (here, an emoji — 4-byte UTF-8,
      // lead byte 0xF0) always sorts AFTER a 3-byte-encoded BMP character (here, a
      // fullwidth exclamation mark — lead byte 0xEF) in Go, because 0xF0 > 0xEF. JS's
      // default `Array.prototype.sort()` instead compares UTF-16 code units, under which
      // the emoji's surrogate-pair lead unit (0xD83D) sorts BEFORE the fullwidth
      // exclamation mark's code unit (0xFF01) — the opposite order. Verified empirically
      // against a real Go `sort.Strings` call: it places the fullwidth-exclamation file
      // first.
      const dir = mkdtempSync(join(tmpdir(), "legacy-sql-glob-utf8-sort-"));
      const schemasDir = join(dir, "schemas");
      mkdirSync(schemasDir);
      writeFileSync(join(schemasDir, "\u{1F600}.sql"), "select 1;"); // 😀
      writeFileSync(join(schemasDir, "！.sql"), "select 2;"); // ！
      return run(["schemas/*.sql"], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual(["schemas/！.sql", "schemas/\u{1F600}.sql"]);
            expect(result.warnings).toEqual([]);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );
});
