import { BunFileSystem, BunPath, BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { useLegacyTempWorkdir } from "../../../tests/helpers/legacy-mocks.ts";
import { legacySqlFilesGlob } from "./legacy-sql-files-glob.ts";

const tempRoot = useLegacyTempWorkdir("legacy-sql-glob-");

const writeFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  relativePath: string,
  content: string,
) => {
  const fullPath = path.join(workdir, relativePath);
  return fs
    .makeDirectory(path.dirname(fullPath), { recursive: true })
    .pipe(Effect.andThen(fs.writeFileString(fullPath, content)));
};

const withFixture = <A>(
  use: (
    dir: string,
    fs: FileSystem.FileSystem,
    path: Path.Path,
  ) => Effect.Effect<A, Error, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* use(tempRoot.current, fs, path);
  }).pipe(Effect.provide(BunServices.layer), Effect.orDie);

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
      // `fs.Glob`/`afero.Glob` resolve a no-metacharacter pattern via `Lstat`, which
      // errors on an empty path — an empty `schema_paths`/`sql_paths` entry (e.g.
      // `schema_paths = [""]`) always yields no matches, never the workdir itself.
      return withFixture((dir) =>
        Effect.gen(function* () {
          const result = yield* run([""], dir);
          expect(result.files).toEqual([]);
          expect(result.warnings).toEqual(["no files matched pattern: "]);
        }),
      );
    },
  );

  it.effect(
    "does not follow a symlinked .sql file below a matched directory (Go WalkDir parity)",
    () => {
      // `Glob.SQLFiles` expands a matched directory with `fs.WalkDir`, which types
      // each child from its parent's `ReadDir` entry (`os.ReadDir`'s Lstat-based
      // `DirEntry`) and never re-`Stat`s through it — so a symlinked `.sql` file is
      // never included, regardless of what it points to.
      return withFixture((dir, fs, path) =>
        Effect.gen(function* () {
          const schemasDir = path.join(dir, "schemas");
          const outsideDir = path.join(dir, "outside");
          yield* writeFile(fs, path, dir, "schemas/real.sql", "select 1;");
          yield* writeFile(fs, path, dir, "outside/evil.sql", "select 2;");
          yield* fs.symlink(path.join(outsideDir, "evil.sql"), path.join(schemasDir, "linked.sql"));
          const result = yield* run(["schemas"], dir);
          expect(result.files).toEqual(["schemas/real.sql"]);
          expect(result.warnings).toEqual([]);
        }),
      );
    },
  );

  it.effect(
    "does not recurse into a symlinked subdirectory below a matched directory (Go WalkDir parity)",
    () => {
      return withFixture((dir, fs, path) =>
        Effect.gen(function* () {
          const schemasDir = path.join(dir, "schemas");
          const outsideSubdir = path.join(dir, "outside-subdir");
          yield* writeFile(fs, path, dir, "schemas/real.sql", "select 1;");
          yield* writeFile(fs, path, dir, "outside-subdir/nested.sql", "select 3;");
          yield* fs.symlink(outsideSubdir, path.join(schemasDir, "linked-dir"));
          const result = yield* run(["schemas"], dir);
          expect(result.files).toEqual(["schemas/real.sql"]);
          expect(result.warnings).toEqual([]);
        }),
      );
    },
  );

  it.effect(
    "surfaces a stat failure on a matched file as a warning instead of treating it as a regular file (Go parity)",
    () => {
      // `if info, err := fs.Stat(fsys, fp); err != nil { allErrors = append(allErrors,
      // errors.Errorf("failed to stat matched file: %w", err)); continue }` —
      // a match that disappears (or is a broken symlink) between the glob and this stat
      // becomes a warning and is skipped entirely, never silently treated as a regular file.
      //
      // `fsys` here is always `afero.NewOsFs()` with the process cwd already the
      // workdir, so `fs.Stat(fsys, fp)`'s embedded path
      // in the resulting error is the workdir-RELATIVE `fp` (verified directly against
      // `os.Stat`/`afero.OsFs.Stat`, which pass the name through to `os.Stat` unchanged).
      // This module never `process.chdir`s, so the real stat needs an absolute path — but
      // the warning must still report the relative form, not that absolute (temp-dir)
      // path, or it would leak a local filesystem path Go never would.
      return withFixture((dir, fs, path) =>
        Effect.gen(function* () {
          const schemasDir = path.join(dir, "schemas");
          yield* writeFile(fs, path, dir, "schemas/good.sql", "select 1;");
          yield* fs.symlink(
            path.join(schemasDir, "does-not-exist.sql"),
            path.join(schemasDir, "broken.sql"),
          );
          const result = yield* run(["schemas/*.sql"], dir);
          expect(result.files).toEqual(["schemas/good.sql"]);
          expect(result.warnings).toHaveLength(1);
          expect(result.warnings[0]).toMatch(/^failed to stat matched file: /);
          expect(result.warnings[0]).toContain("schemas/broken.sql");
          expect(result.warnings[0]).not.toContain(dir);
        }),
      );
    },
  );

  it.effect(
    "surfaces a stat failure for a LITERAL (no-metacharacter) pattern naming a broken symlink, instead of reporting no match (Go afero.Glob Lstat parity)",
    () => {
      // `fs.Glob`/`afero.Glob` no-metacharacter fast path probes
      // via `Lstat` (`OsFs.LstatIfPossible` → `os.Lstat`), which does NOT follow a
      // symlink — so a LITERAL pattern naming a broken symlink still Lstat-succeeds (the
      // link itself exists) and is reported as a match; the follow-up `fs.Stat` above is
      // what then fails with `failed to stat matched file: ...`, exactly like the
      // wildcard-pattern case the previous test covers. Verified empirically
      // (`afero.Glob`/`fs.Stat` scratch probe): a literal broken-symlink
      // pattern always Globs to a match and always fails the follow-up Stat — never
      // "no files matched pattern".
      return withFixture((dir, fs, path) =>
        Effect.gen(function* () {
          const schemasDir = path.join(dir, "schemas");
          yield* fs.makeDirectory(schemasDir, { recursive: true });
          yield* fs.symlink(
            path.join(schemasDir, "does-not-exist.sql"),
            path.join(schemasDir, "broken.sql"),
          );
          const result = yield* run(["schemas/broken.sql"], dir);
          expect(result.files).toEqual([]);
          expect(result.warnings).toHaveLength(1);
          expect(result.warnings[0]).toMatch(/^failed to stat matched file: /);
          expect(result.warnings[0]).toContain("schemas/broken.sql");
        }),
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
      // root one is deliberately preserved. Verified empirically:
      // with cwd elsewhere, a pattern rooted at "/" with a metacharacter in the first
      // component after the root slash still resolves against the filesystem ROOT, not
      // cwd. A canary file placed in the WORKDIR (never the real "/") proves this native
      // port does not fall back to treating the root component as workdir-relative.
      return withFixture((dir, fs, path) =>
        Effect.gen(function* () {
          yield* writeFile(fs, path, dir, "__legacy_sql_glob_canary__.sql", "select 1;");
          const result = yield* run(["/*__legacy_sql_glob_canary__*.sql"], dir);
          expect(result.files).toEqual([]);
          expect(result.warnings).toEqual([
            "no files matched pattern: /*__legacy_sql_glob_canary__*.sql",
          ]);
        }),
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
      return withFixture((dir, fs, path) =>
        Effect.gen(function* () {
          yield* writeFile(fs, path, dir, "__legacy_sql_glob_root_canary_dir__/a.sql", "select 1;");
          const result = yield* run(["/__legacy_sql_glob_root_canary_dir__*/*.sql"], dir);
          expect(result.files).toEqual([]);
          expect(result.warnings).toEqual([
            "no files matched pattern: /__legacy_sql_glob_root_canary_dir__*/*.sql",
          ]);
        }),
      );
    },
  );

  it.effect(
    "preserves a Windows drive root ('C:/') as the directory when splitting a glob pattern (Go filepath.Split parity)",
    () => {
      // `filepath.Split` treats `"C:"` as the volume name on Windows
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
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = tempRoot.current;
        const canaryFile = `${dir}/a.sql`;
        yield* fs.writeFileString(canaryFile, "select 1;");
        // A "C:/" drive root doesn't exist on this (non-Windows) test host, so
        // fake just the two calls that must resolve against it, reusing a real
        // file's stat info to avoid hand-rolling a `File.Info`.
        const realFileInfo = yield* fs.stat(canaryFile);
        const driveRootFs: FileSystem.FileSystem = {
          ...fs,
          readDirectory: (p: string) =>
            p === "C:/" ? Effect.succeed(["a.sql"]) : fs.readDirectory(p),
          stat: (p: string) => (p === "C:/a.sql" ? Effect.succeed(realFileInfo) : fs.stat(p)),
        };
        const result = yield* legacySqlFilesGlob(driveRootFs, path, ["C:/*.sql"], dir);
        expect(result.files).toEqual(["C:/a.sql"]);
        expect(result.warnings).toEqual([]);
      }).pipe(
        Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layerWin32)),
        Effect.ensuring(
          Effect.sync(() =>
            Object.defineProperty(process, "platform", { value: originalPlatform }),
          ),
        ),
      );
    },
  );

  it.effect(
    "reports the raw backslash pattern in a 'no files matched' warning on Windows, not the slashed form used for matching (Go filepath.ToSlash parity)",
    () => {
      // Go passes `filepath.ToSlash(pattern)` only as an ARGUMENT to `fs.Glob` —
      // the loop's own `pattern` variable (Go's range variable) is
      // never reassigned, so the "no files matched pattern: %s" warning
      // still reports the ORIGINAL backslash form. An absolute Windows pattern with
      // backslashes that matches nothing must therefore warn with that backslash form,
      // not the slashed one used internally to glob. Force win32 path semantics
      // (`BunPath.layerWin32`) and this module's own `process.platform` gate, same as
      // the drive-root test above.
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* legacySqlFilesGlob(
          fs,
          path,
          ["C:\\schemas\\*.sql"],
          tempRoot.current,
        );
        expect(result.files).toEqual([]);
        expect(result.warnings).toEqual(["no files matched pattern: C:\\schemas\\*.sql"]);
      }).pipe(
        Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layerWin32)),
        Effect.ensuring(
          Effect.sync(() =>
            Object.defineProperty(process, "platform", { value: originalPlatform }),
          ),
        ),
      );
    },
  );

  it.effect(
    "sorts raw backslash-joined Windows matches BEFORE slashing, not after (Go afero.Glob/filepath.ToSlash ordering parity)",
    () => {
      // `config.Glob.SQLFiles` calls `fs.Glob`, which resolves
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
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const scratchDir = tempRoot.current;
        const canaryFile = `${scratchDir}/canary.sql`;
        yield* fs.writeFileString(canaryFile, "select 1;");
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
        const result = yield* legacySqlFilesGlob(winFs, path, ["a*/x.sql"], workdir);
        expect(result.files).toEqual(["a0/x.sql", "a/x.sql"]);
        expect(result.warnings).toEqual([]);
      }).pipe(
        Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layerWin32)),
        Effect.ensuring(
          Effect.sync(() =>
            Object.defineProperty(process, "platform", { value: originalPlatform }),
          ),
        ),
      );
    },
  );

  it.effect(
    "normalizes a doubled slash when the matched directory itself has a trailing slash (Go path.Join parity)",
    () => {
      // `fs.WalkDir` builds each child path via `path.Join(dirname, name)`
      // (`io/fs/walk.go`), and `path.Join` runs `path.Clean` on the result, collapsing a
      // doubled `/`. A literal (no-metacharacter) `schema_paths`/`sql_paths` entry like
      // `"schemas/"` resolves via `fs.Glob`'s fast path to the pattern VERBATIM, trailing
      // slash and all — so the walk over its children must not produce `schemas//a.sql`.
      // Verified empirically: a scratch probe calling
      // `config.Glob{"<dir>/"}.SQLFiles(...)` on a real trailing-slash directory returns
      // the single-slash path, not a doubled one.
      return withFixture((dir, fs, path) =>
        Effect.gen(function* () {
          yield* writeFile(fs, path, dir, "schemas/a.sql", "select 1;");
          const result = yield* run(["schemas/"], dir);
          expect(result.files).toEqual(["schemas/a.sql"]);
          expect(result.warnings).toEqual([]);
        }),
      );
    },
  );

  it.effect(
    "drops the './' prefix when the matched directory cleans to '.' (Go path.Join parity)",
    () => {
      // `fs.WalkDir` builds each child path via `path.Join(dirname, name)`, and
      // `path.Join` runs `path.Clean`, which drops a bare `.` root entirely rather than
      // joining it as a prefix. A matched directory can clean to exactly `.` — e.g.
      // `[db.migrations].schema_paths = [".."]`/`[db.seed].sql_paths = [".."]`, which
      // `baseConfig.resolve`'s own `path.Join(builder.SupabaseDirPath, pattern)` collapses
      // to `.` — so the walk over its children
      // must record `a.sql`, not `./a.sql`. This matters beyond cosmetics: for seeds, the
      // walked path becomes the `supabase_migrations.seed_files.path` hash key, so a
      // `./`-prefixed path would never match an already-recorded Go-CLI key. Verified
      // empirically: `path.Join(".", "foo.sql")` and a real `fs.WalkDir` rooted at `.` both
      // drop the `./` prefix entirely.
      return withFixture((dir, fs, path) =>
        Effect.gen(function* () {
          yield* writeFile(fs, path, dir, "a.sql", "select 1;");
          yield* writeFile(fs, path, dir, "nested/b.sql", "select 2;");
          const result = yield* run(["."], dir);
          expect(result.files).toEqual(["a.sql", "nested/b.sql"]);
          expect(result.warnings).toEqual([]);
        }),
      );
    },
  );

  it.effect(
    "cleans a '..'-segment matched directory when walking its children (Go path.Join parity)",
    () => {
      // `fs.WalkDir` builds each child path via `path.Join(dirname, name)`, and
      // `path.Join` runs `path.Clean`, which lexically resolves an embedded `..` segment —
      // not just a bare `.` root or a trailing slash. A matched directory can contain a
      // `..` anywhere, e.g. `[db.migrations].schema_paths = ["nested/../schemas"]`, and the
      // walk over its children must record `schemas/a.sql`, not `nested/../schemas/a.sql`.
      // Verified empirically: `path.Join("/tmp/x/../schemas", "a.sql")` and Node's
      // `path.join("/tmp/x/../schemas", "a.sql")` both clean to `/tmp/schemas/a.sql`.
      return withFixture((dir, fs, path) =>
        Effect.gen(function* () {
          yield* writeFile(fs, path, dir, "schemas/a.sql", "select 1;");
          const result = yield* run(["nested/../schemas"], dir);
          expect(result.files).toEqual(["schemas/a.sql"]);
          expect(result.warnings).toEqual([]);
        }),
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
      // `filepath.Join(dir, n)` — so the recorded match is the CLEANED
      // `schemas/a.sql`, not a raw `schemas/./a.sql` concatenation. Verified empirically:
      // a scratch `afero.Glob(fs, ".../tmp/./schemas/*.sql")` probe against a real
      // filesystem returns the cleaned path.
      return withFixture((dir, fs, path) =>
        Effect.gen(function* () {
          yield* writeFile(fs, path, dir, "schemas/a.sql", "select 1;");
          const result = yield* run(["schemas/./*.sql"], dir);
          expect(result.files).toEqual(["schemas/a.sql"]);
          expect(result.warnings).toEqual([]);
        }),
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
      return withFixture((dir, fs, path) =>
        Effect.gen(function* () {
          yield* writeFile(fs, path, dir, "schemas/a.sql", "select 1;");
          const result = yield* run(["nested/../schemas/*.sql"], dir);
          expect(result.files).toEqual(["schemas/a.sql"]);
          expect(result.warnings).toEqual([]);
        }),
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
      return withFixture((dir, fs, path) =>
        Effect.gen(function* () {
          yield* writeFile(fs, path, dir, "schemas/a.sql", "select 1;");
          const result = yield* run(["schemas//*.sql"], dir);
          expect(result.files).toEqual(["schemas/a.sql"]);
          expect(result.warnings).toEqual([]);
        }),
      );
    },
  );

  it.effect(
    "still includes a '.sql' child whose stat fails after it's already listed (Go WalkDir parity)",
    () => {
      // `fs.WalkDir` types each child from the parent's `ReadDir`-returned `DirEntry`
      // and never re-`Stat`s through it, so a `.sql` file that disappears between `ReadDir`
      // and its own visit stays in Go's declared file list — only the later, real file-open
      // fails. Simulate the stat failure directly (mocking a real race is flaky) by pointing
      // the matched directory at one that lists a child but whose child path is unreadable:
      // a broken symlink target used as a bare filename via a `readLink` failure isn't
      // enough here (that's the earlier symlink test), so exercise the `fs.stat` failure
      // path itself by removing the file the instant after `readDirectory` returns it, via
      // a `FileSystem` layer that deletes on first `stat` call for that path.
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = tempRoot.current;
        const racyFile = path.join(dir, "schemas", "racy.sql");
        yield* writeFile(fs, path, dir, "schemas/racy.sql", "select 1;");
        const racyFs: FileSystem.FileSystem = {
          ...fs,
          stat: (p: string) =>
            p === racyFile ? fs.remove(racyFile).pipe(Effect.andThen(fs.stat(p))) : fs.stat(p),
        };
        const result = yield* legacySqlFilesGlob(racyFs, path, ["schemas"], dir);
        expect(result.files).toEqual(["schemas/racy.sql"]);
        expect(result.warnings).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "fails the whole walk when a non-'.sql' child whose stat fails could have been a subdirectory (Go WalkDir parity)",
    () => {
      // Round 6 (test above) established that a `.sql` FILE child racing away between
      // `readDirectory` and this port's own `stat` call is best-effort included, matching
      // Go's cached-`DirEntry` behaviour for regular files. But `fs.WalkDir` does NOT
      // treat every vanished child the same way: for a DIRECTORY `DirEntry`, it unconditionally
      // attempts a second `ReadDir` to recurse into it; when that child is gone, the second
      // `ReadDir` fails, and `walkMatchedDir`'s callback propagates the error unchanged
      // (`if err != nil { return err }`) — `fs.WalkDir` returns it, and
      // `walkMatchedDir` wraps it as `failed to walk matched directory: <cause>`, discarding
      // every file already collected. Verified empirically with a
      // scratch `fs.WalkDir` probe against the real `walkMatchedDir`: removing a
      // nested subdirectory between the parent's `ReadDir` and the subdirectory's own `ReadDir`
      // reproduces exactly this — zero files, `failed to walk matched directory: open...
      // /nested: no such file or directory` — never a silent skip. This port's `stat` call
      // is a second, separate syscall from the parent's `readDirectory` (unlike Go, which gets
      // the child's type for free from the SAME syscall as the listing), so a raced
      // disappearance here always loses the type along with the entry — a non-`.sql` name
      // could equally have been the now-missing subdirectory, and must fail the same way an
      // unreadable still-present directory does, not silently vanish along with the files it
      // may have held.
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = tempRoot.current;
        const nestedDir = path.join(dir, "schemas", "nested");
        yield* writeFile(fs, path, dir, "schemas/a.sql", "select 1;");
        yield* writeFile(fs, path, dir, "schemas/nested/b.sql", "select 2;");
        const racyFs: FileSystem.FileSystem = {
          ...fs,
          stat: (p: string) =>
            p === nestedDir
              ? fs.remove(nestedDir, { recursive: true }).pipe(Effect.andThen(fs.stat(p)))
              : fs.stat(p),
        };
        const result = yield* legacySqlFilesGlob(racyFs, path, ["schemas"], dir);
        expect(result.files).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatch(/^failed to walk matched directory: /);
        expect(result.warnings[0]).toContain("schemas/nested");
        expect(result.warnings[0]).not.toContain(dir);
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect("still expands a real (non-symlinked) nested directory recursively", () => {
    return withFixture((dir, fs, path) =>
      Effect.gen(function* () {
        yield* writeFile(fs, path, dir, "schemas/a.sql", "select 1;");
        yield* writeFile(fs, path, dir, "schemas/nested/b.sql", "select 2;");
        const result = yield* run(["schemas"], dir);
        expect(result.files).toEqual(["schemas/a.sql", "schemas/nested/b.sql"]);
        expect(result.warnings).toEqual([]);
      }),
    );
  });

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it.effect.skipIf(isRoot)(
    "surfaces a directory-read failure during walk as a warning instead of an empty match (Go WalkDir parity)",
    () => {
      // `fs.WalkDir` returns the `ReadDir` error from its walkFn unchanged, which
      // stops the walk immediately; `walkMatchedDir` then wraps it as `failed to walk
      // matched directory: ...` and discards every file already found — never an empty
      // (successful) match. Verified empirically: an unreadable
      // matched directory makes `Glob.SQLFiles` return that error with zero files.
      //
      // `fsys` here is always `afero.OsFs` with the process cwd already the workdir,
      // so the `ReadDir` error's embedded path is the
      // workdir-relative matched directory (`schemas`), never an absolute one. This
      // module never `process.chdir`s, so the real read needs an absolute path, but the
      // warning must still report the relative form.
      return withFixture((dir, fs, path) =>
        Effect.gen(function* () {
          const schemasDir = path.join(dir, "schemas");
          yield* writeFile(fs, path, dir, "schemas/a.sql", "select 1;");
          yield* fs.chmod(schemasDir, 0o000);
          const result = yield* run(["schemas"], dir);
          expect(result.files).toEqual([]);
          expect(result.warnings).toHaveLength(1);
          expect(result.warnings[0]).toMatch(/^failed to walk matched directory: /);
          expect(result.warnings[0]).toContain("schemas");
          expect(result.warnings[0]).not.toContain(dir);
          yield* fs.chmod(schemasDir, 0o755);
        }),
      );
    },
  );

  it.effect.skipIf(isRoot)(
    "surfaces a NESTED directory-read failure during walk with a workdir-relative path, not the matched root's (Go WalkDir parity)",
    () => {
      // Same leak as the matched-root-directory case above, but for a failure during the
      // RECURSIVE walk of an already-descended subdirectory — a distinct code path inside
      // `fs.WalkDir` callback (it recurses via the SAME `ReadDir` call the matched
      // root used, `io/fs/walk.go`), and this port's `walk()` closure recurses the same
      // way. The matched root ("schemas") itself is readable; only "schemas/nested" is
      // not, so the warning must report "schemas/nested", never the workdir's absolute
      // temp-dir path.
      return withFixture((dir, fs, path) =>
        Effect.gen(function* () {
          const nestedDir = path.join(dir, "schemas", "nested");
          yield* writeFile(fs, path, dir, "schemas/a.sql", "select 1;");
          yield* writeFile(fs, path, dir, "schemas/nested/b.sql", "select 2;");
          yield* fs.chmod(nestedDir, 0o000);
          const result = yield* run(["schemas"], dir);
          expect(result.files).toEqual([]);
          expect(result.warnings).toHaveLength(1);
          expect(result.warnings[0]).toMatch(/^failed to walk matched directory: /);
          expect(result.warnings[0]).toContain("schemas/nested");
          expect(result.warnings[0]).not.toContain(dir);
          yield* fs.chmod(nestedDir, 0o755);
        }),
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
      return withFixture((dir, fs, path) =>
        Effect.gen(function* () {
          const badDir = path.join(dir, "bad");
          yield* writeFile(fs, path, dir, "good/a.sql", "select 1;");
          yield* writeFile(fs, path, dir, "bad/b.sql", "select 2;");
          yield* fs.chmod(badDir, 0o000);
          const result = yield* run(["good", "bad"], dir);
          expect(result.files).toEqual(["good/a.sql"]);
          expect(result.warnings).toHaveLength(1);
          expect(result.warnings[0]).toMatch(/^failed to walk matched directory: /);
          yield* fs.chmod(badDir, 0o755);
        }),
      );
    },
  );

  it.effect.skipIf(isRoot)(
    "picks the lexically-first failing subdirectory as the fatal error, matching Go's fs.WalkDir sorted-visit order (review CLI-1958)",
    () => {
      // `fs.WalkDir` visits directory entries in lexical byte order — its
      // `ReadDir` (`os.ReadDir`/`afero.OsFs`) contract guarantees results "sorted by
      // filename" before `walkDir` ever iterates them, so when a matched directory
      // has MULTIPLE unreadable subdirectories, Go deterministically fails on the
      // FIRST one lexically ("aaa" before "bbb") and never even attempts the second.
      // This module's own `readDirectory` makes no such ordering promise, so this
      // test provides a fake `FileSystem` whose `readDirectory` deliberately returns
      // "schemas"'s children in REVERSE order ("bbb" before "aaa") — the opposite of
      // Go's guaranteed order — to prove the walk sorts them back (`utf8Compare`)
      // before iterating, rather than trusting raw (here: adversarial) enumeration
      // order.
      return Effect.gen(function* () {
        const realFs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = tempRoot.current;
        const schemasDir = path.join(dir, "schemas");
        const aaaDir = path.join(schemasDir, "aaa");
        const bbbDir = path.join(schemasDir, "bbb");
        yield* realFs.makeDirectory(aaaDir, { recursive: true });
        yield* realFs.makeDirectory(bbbDir, { recursive: true });
        yield* realFs.chmod(aaaDir, 0o000);
        yield* realFs.chmod(bbbDir, 0o000);
        const reorderedFs: FileSystem.FileSystem = {
          ...realFs,
          readDirectory: (p, opts) =>
            realFs
              .readDirectory(p, opts)
              .pipe(
                Effect.map((names) => (p === schemasDir ? [...names].sort().reverse() : names)),
              ),
        };
        const result = yield* legacySqlFilesGlob(reorderedFs, path, ["schemas"], dir);
        expect(result.files).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        // Go descends into "aaa" first (lexical order), fails reading it, and stops —
        // "bbb" is never even attempted.
        expect(result.warnings[0]).toContain("schemas/aaa");
        expect(result.warnings[0]).not.toContain("schemas/bbb");
        yield* realFs.chmod(aaaDir, 0o755);
        yield* realFs.chmod(bbbDir, 0o755);
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "sorts direct wildcard matches by UTF-8 byte order, not UTF-16 code units (Go sort.Strings parity)",
    () => {
      // `sort.Strings` (`Glob.SQLFiles`) orders the raw UTF-8 bytes
      // of each match. A supplementary-plane character (here, an emoji — 4-byte UTF-8,
      // lead byte 0xF0) always sorts AFTER a 3-byte-encoded BMP character (here, a
      // fullwidth exclamation mark — lead byte 0xEF) in Go, because 0xF0 > 0xEF. JS's
      // default `Array.prototype.sort()` instead compares UTF-16 code units, under which
      // the emoji's surrogate-pair lead unit (0xD83D) sorts BEFORE the fullwidth
      // exclamation mark's code unit (0xFF01) — the opposite order. Verified empirically
      // against a real Go `sort.Strings` call: it places the fullwidth-exclamation file
      // first.
      return withFixture((dir, fs, path) =>
        Effect.gen(function* () {
          yield* writeFile(fs, path, dir, "schemas/\u{1F600}.sql", "select 1;"); // 😀
          yield* writeFile(fs, path, dir, "schemas/！.sql", "select 2;"); // ！
          const result = yield* run(["schemas/*.sql"], dir);
          expect(result.files).toEqual(["schemas/！.sql", "schemas/\u{1F600}.sql"]);
          expect(result.warnings).toEqual([]);
        }),
      );
    },
  );
});
