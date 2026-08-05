import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

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
});
