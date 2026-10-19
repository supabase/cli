import { BunPath, BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { sqlFilesGlob } from "./sql-files-glob.ts";

const run = (patterns: ReadonlyArray<string>, workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* sqlFilesGlob(fs, path, patterns, workdir);
  });

const tempWorkdir = Effect.fnUntraced(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return { fs, path, dir: yield* fs.makeTempDirectoryScoped({ prefix }) };
});

/**
 * Runs `use` with win32 path semantics (`BunPath.layerWin32` + `process.platform`), the same
 * branch a real Windows install takes.
 */
const withWin32Path = <A, E, R>(use: (path: Path.Path) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const platform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      return platform;
    }),
    () => Effect.flatMap(Path.Path, use).pipe(Effect.provide(BunPath.layerWin32)),
    (platform) =>
      Effect.sync(() => {
        Object.defineProperty(process, "platform", { value: platform });
      }),
  );

/** Runs `body` with `target` at `mode`, then restores it so the temp dir can be removed. */
const withMode = <A, E, R>(target: string, mode: number, body: Effect.Effect<A, E, R>) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.acquireUseRelease(
      fs.chmod(target, mode),
      () => body,
      () => Effect.orDie(fs.chmod(target, 0o755)),
    ),
  );

layer(BunServices.layer)("sqlFilesGlob", (it) => {
  it.effect("treats an empty pattern as no match, not the workdir itself (Go fs.Glob parity)", () =>
    Effect.gen(function* () {
      const { dir } = yield* tempWorkdir("sql-glob-empty-");
      const result = yield* run([""], dir);
      expect(result.files).toEqual([]);
      expect(result.warnings).toEqual(["no files matched pattern: "]);
    }),
  );

  it.effect(
    "does not follow a symlinked .sql file below a matched directory (Go WalkDir parity)",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-symlink-file-");
        const schemasDir = path.join(dir, "schemas");
        yield* fs.makeDirectory(schemasDir);
        yield* fs.writeFileString(path.join(schemasDir, "real.sql"), "select 1;");
        const outsideDir = path.join(dir, "outside");
        yield* fs.makeDirectory(outsideDir);
        yield* fs.writeFileString(path.join(outsideDir, "evil.sql"), "select 2;");
        yield* fs.symlink(path.join(outsideDir, "evil.sql"), path.join(schemasDir, "linked.sql"));
        const result = yield* run(["schemas"], dir);
        expect(result.files).toEqual(["schemas/real.sql"]);
        expect(result.warnings).toEqual([]);
      }),
  );

  it.effect(
    "does not recurse into a symlinked subdirectory below a matched directory (Go WalkDir parity)",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-symlink-dir-");
        const schemasDir = path.join(dir, "schemas");
        yield* fs.makeDirectory(schemasDir);
        yield* fs.writeFileString(path.join(schemasDir, "real.sql"), "select 1;");
        const outsideSubdir = path.join(dir, "outside-subdir");
        yield* fs.makeDirectory(outsideSubdir);
        yield* fs.writeFileString(path.join(outsideSubdir, "nested.sql"), "select 3;");
        yield* fs.symlink(outsideSubdir, path.join(schemasDir, "linked-dir"));
        const result = yield* run(["schemas"], dir);
        expect(result.files).toEqual(["schemas/real.sql"]);
        expect(result.warnings).toEqual([]);
      }),
  );

  it.effect(
    "surfaces a stat failure on a matched file as a warning instead of treating it as a regular file (Go parity)",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-stat-fail-");
        const schemasDir = path.join(dir, "schemas");
        yield* fs.makeDirectory(schemasDir);
        yield* fs.writeFileString(path.join(schemasDir, "good.sql"), "select 1;");
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

  it.effect(
    "surfaces a stat failure for a LITERAL (no-metacharacter) pattern naming a broken symlink, instead of reporting no match (Go afero.Glob Lstat parity)",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-literal-symlink-");
        const schemasDir = path.join(dir, "schemas");
        yield* fs.makeDirectory(schemasDir);
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

  it.effect(
    "keeps a bare root ('/') as the directory when a glob pattern's meta character is in the first path component (Go afero.Glob parity)",
    () =>
      Effect.gen(function* () {
        // The canary file lives in the workdir (never the real "/"), proving this doesn't
        // fall back to treating the root component as workdir-relative.
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-abs-root-");
        yield* fs.writeFileString(path.join(dir, "__legacy_sql_glob_canary__.sql"), "select 1;");
        const result = yield* run(["/*__legacy_sql_glob_canary__*.sql"], dir);
        expect(result.files).toEqual([]);
        expect(result.warnings).toEqual([
          "no files matched pattern: /*__legacy_sql_glob_canary__*.sql",
        ]);
      }),
  );

  it.effect(
    "recurses through a root-anchored directory component without falling back to the workdir (Go afero.Glob parity)",
    () =>
      Effect.gen(function* () {
        // The workdir here contains a subdirectory that would match "foo*" only if the
        // recursive call incorrectly fell back to reading the workdir instead of "/".
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-abs-root-nested-");
        const canaryDir = path.join(dir, "__legacy_sql_glob_root_canary_dir__");
        yield* fs.makeDirectory(canaryDir);
        yield* fs.writeFileString(path.join(canaryDir, "a.sql"), "select 1;");
        const result = yield* run(["/__legacy_sql_glob_root_canary_dir__*/*.sql"], dir);
        expect(result.files).toEqual([]);
        expect(result.warnings).toEqual([
          "no files matched pattern: /__legacy_sql_glob_root_canary_dir__*/*.sql",
        ]);
      }),
  );

  it.effect(
    "preserves a Windows drive root ('C:/') as the directory when splitting a glob pattern (Go filepath.Split parity)",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-drive-root-");
        const file = path.join(dir, "a.sql");
        yield* fs.writeFileString(file, "select 1;");
        // A "C:/" drive root doesn't exist on this test host, so fake just the two calls that
        // must resolve against it, reusing a real file's stat info.
        const realFileInfo = yield* fs.stat(file);
        const driveRootFs: FileSystem.FileSystem = {
          ...fs,
          readDirectory: (p: string) =>
            p === "C:/" ? Effect.succeed(["a.sql"]) : fs.readDirectory(p),
          stat: (p: string) => (p === "C:/a.sql" ? Effect.succeed(realFileInfo) : fs.stat(p)),
        };
        const result = yield* withWin32Path((win32Path) =>
          sqlFilesGlob(driveRootFs, win32Path, ["C:/*.sql"], dir),
        );
        expect(result.files).toEqual(["C:/a.sql"]);
        expect(result.warnings).toEqual([]);
      }),
  );

  it.effect(
    "reports the raw backslash pattern in a 'no files matched' warning on Windows, not the slashed form used for matching (Go filepath.ToSlash parity)",
    () =>
      Effect.gen(function* () {
        const { fs, dir } = yield* tempWorkdir("sql-glob-win-warn-");
        const result = yield* withWin32Path((win32Path) =>
          sqlFilesGlob(fs, win32Path, ["C:\\schemas\\*.sql"], dir),
        );
        expect(result.files).toEqual([]);
        expect(result.warnings).toEqual(["no files matched pattern: C:\\schemas\\*.sql"]);
      }),
  );

  it.effect(
    "sorts raw backslash-joined Windows matches BEFORE slashing, not after (Go afero.Glob/filepath.ToSlash ordering parity)",
    () =>
      Effect.gen(function* () {
        // For `a\x.sql` vs `a0\x.sql`, sorting the raw backslash bytes puts `a0\x.sql` first
        // (`\` is `0x5C` > `0`'s `0x30`), while sorting the slashed form would put `a/x.sql`
        // first instead — a fully faked filesystem supplies canned results keyed by the exact
        // backslash-joined paths `BunPath.layerWin32`'s `path.join` computes.
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-win-sort-");
        const canaryFile = path.join(dir, "canary.sql");
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
        const result = yield* withWin32Path((win32Path) =>
          sqlFilesGlob(winFs, win32Path, ["a*/x.sql"], workdir),
        );
        expect(result.files).toEqual(["a0/x.sql", "a/x.sql"]);
        expect(result.warnings).toEqual([]);
      }),
  );

  it.effect(
    "normalizes a doubled slash when the matched directory itself has a trailing slash (Go path.Join parity)",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-trailing-slash-");
        const schemasDir = path.join(dir, "schemas");
        yield* fs.makeDirectory(schemasDir);
        yield* fs.writeFileString(path.join(schemasDir, "a.sql"), "select 1;");
        const result = yield* run(["schemas/"], dir);
        expect(result.files).toEqual(["schemas/a.sql"]);
        expect(result.warnings).toEqual([]);
      }),
  );

  it.effect(
    "drops the './' prefix when the matched directory cleans to '.' (Go path.Join parity)",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-dot-root-");
        yield* fs.writeFileString(path.join(dir, "a.sql"), "select 1;");
        const nestedDir = path.join(dir, "nested");
        yield* fs.makeDirectory(nestedDir);
        yield* fs.writeFileString(path.join(nestedDir, "b.sql"), "select 2;");
        const result = yield* run(["."], dir);
        expect(result.files).toEqual(["a.sql", "nested/b.sql"]);
        expect(result.warnings).toEqual([]);
      }),
  );

  it.effect(
    "cleans a '..'-segment matched directory when walking its children (Go path.Join parity)",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-dotdot-segment-");
        const schemasDir = path.join(dir, "schemas");
        yield* fs.makeDirectory(schemasDir);
        yield* fs.writeFileString(path.join(schemasDir, "a.sql"), "select 1;");
        const result = yield* run(["nested/../schemas"], dir);
        expect(result.files).toEqual(["schemas/a.sql"]);
        expect(result.warnings).toEqual([]);
      }),
  );

  it.effect(
    "cleans a direct glob match whose directory portion has a '.' segment (Go afero.Glob parity)",
    () =>
      Effect.gen(function* () {
        // Distinct from the walked-child cleaning tests above: the glob metacharacter is in
        // the final component, so this matches directly via `globOne`, never `walkSqlFiles`.
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-direct-dot-segment-");
        const schemasDir = path.join(dir, "schemas");
        yield* fs.makeDirectory(schemasDir);
        yield* fs.writeFileString(path.join(schemasDir, "a.sql"), "select 1;");
        const result = yield* run(["schemas/./*.sql"], dir);
        expect(result.files).toEqual(["schemas/a.sql"]);
        expect(result.warnings).toEqual([]);
      }),
  );

  it.effect(
    "cleans a direct glob match whose directory portion has a '..' segment (Go afero.Glob parity)",
    () =>
      Effect.gen(function* () {
        // Same distinction as above (a direct match via `globOne`), but for an embedded `..`
        // segment instead of `.`.
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-direct-dotdot-segment-");
        const schemasDir = path.join(dir, "schemas");
        yield* fs.makeDirectory(schemasDir);
        yield* fs.writeFileString(path.join(schemasDir, "a.sql"), "select 1;");
        const result = yield* run(["nested/../schemas/*.sql"], dir);
        expect(result.files).toEqual(["schemas/a.sql"]);
        expect(result.warnings).toEqual([]);
      }),
  );

  it.effect(
    "normalizes a doubled slash for a direct glob match under a trailing-slash directory component (Go afero.Glob parity)",
    () =>
      Effect.gen(function* () {
        // `splitPath` on `"schemas//*.sql"` yields `dir: "schemas/"` (the trailing slash
        // survives the split), so the join must still collapse the doubled slash.
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-direct-doubled-slash-");
        const schemasDir = path.join(dir, "schemas");
        yield* fs.makeDirectory(schemasDir);
        yield* fs.writeFileString(path.join(schemasDir, "a.sql"), "select 1;");
        const result = yield* run(["schemas//*.sql"], dir);
        expect(result.files).toEqual(["schemas/a.sql"]);
        expect(result.warnings).toEqual([]);
      }),
  );

  it.effect(
    "still includes a '.sql' child whose stat fails after it's already listed (Go WalkDir parity)",
    () =>
      Effect.gen(function* () {
        // Simulates the race by deleting the file the instant after `readDirectory` returns
        // it, via a `FileSystem` layer that removes on the first `stat` call for that path.
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-stat-race-");
        const schemasDir = path.join(dir, "schemas");
        yield* fs.makeDirectory(schemasDir);
        const racyFile = path.join(schemasDir, "racy.sql");
        yield* fs.writeFileString(racyFile, "select 1;");
        const racyFs: FileSystem.FileSystem = {
          ...fs,
          stat: (p: string) =>
            p === racyFile ? fs.remove(racyFile).pipe(Effect.andThen(fs.stat(p))) : fs.stat(p),
        };
        const result = yield* sqlFilesGlob(racyFs, path, ["schemas"], dir);
        expect(result.files).toEqual(["schemas/racy.sql"]);
        expect(result.warnings).toEqual([]);
      }),
  );

  it.effect(
    "fails the whole walk when a non-'.sql' child whose stat fails could have been a subdirectory (Go WalkDir parity)",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-dir-race-");
        const schemasDir = path.join(dir, "schemas");
        yield* fs.makeDirectory(schemasDir);
        yield* fs.writeFileString(path.join(schemasDir, "a.sql"), "select 1;");
        const nestedDir = path.join(schemasDir, "nested");
        yield* fs.makeDirectory(nestedDir);
        yield* fs.writeFileString(path.join(nestedDir, "b.sql"), "select 2;");
        const racyFs: FileSystem.FileSystem = {
          ...fs,
          stat: (p: string) =>
            p === nestedDir
              ? fs.remove(nestedDir, { recursive: true }).pipe(Effect.andThen(fs.stat(p)))
              : fs.stat(p),
        };
        const result = yield* sqlFilesGlob(racyFs, path, ["schemas"], dir);
        expect(result.files).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatch(/^failed to walk matched directory: /);
        expect(result.warnings[0]).toContain("schemas/nested");
        expect(result.warnings[0]).not.toContain(dir);
      }),
  );

  it.effect("still expands a real (non-symlinked) nested directory recursively", () =>
    Effect.gen(function* () {
      const { fs, path, dir } = yield* tempWorkdir("sql-glob-nested-");
      const schemasDir = path.join(dir, "schemas");
      const nestedDir = path.join(schemasDir, "nested");
      yield* fs.makeDirectory(nestedDir, { recursive: true });
      yield* fs.writeFileString(path.join(schemasDir, "a.sql"), "select 1;");
      yield* fs.writeFileString(path.join(nestedDir, "b.sql"), "select 2;");
      const result = yield* run(["schemas"], dir);
      expect(result.files).toEqual(["schemas/a.sql", "schemas/nested/b.sql"]);
      expect(result.warnings).toEqual([]);
    }),
  );

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it.effect.skipIf(isRoot)(
    "surfaces a directory-read failure during walk as a warning instead of an empty match (Go WalkDir parity)",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-walk-fail-");
        const schemasDir = path.join(dir, "schemas");
        yield* fs.makeDirectory(schemasDir);
        yield* fs.writeFileString(path.join(schemasDir, "a.sql"), "select 1;");
        const result = yield* withMode(schemasDir, 0o000, run(["schemas"], dir));
        expect(result.files).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatch(/^failed to walk matched directory: /);
        expect(result.warnings[0]).toContain("schemas");
        expect(result.warnings[0]).not.toContain(dir);
      }),
  );

  it.effect.skipIf(isRoot)(
    "surfaces a NESTED directory-read failure during walk with a workdir-relative path, not the matched root's (Go WalkDir parity)",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-walk-fail-nested-");
        const schemasDir = path.join(dir, "schemas");
        const nestedDir = path.join(schemasDir, "nested");
        yield* fs.makeDirectory(nestedDir, { recursive: true });
        yield* fs.writeFileString(path.join(schemasDir, "a.sql"), "select 1;");
        yield* fs.writeFileString(path.join(nestedDir, "b.sql"), "select 2;");
        const result = yield* withMode(nestedDir, 0o000, run(["schemas"], dir));
        expect(result.files).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatch(/^failed to walk matched directory: /);
        expect(result.warnings[0]).toContain("schemas/nested");
        expect(result.warnings[0]).not.toContain(dir);
      }),
  );

  it.effect.skipIf(isRoot)(
    "keeps files from a sibling pattern when only one matched directory fails to walk",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-walk-fail-partial-");
        const goodDir = path.join(dir, "good");
        const badDir = path.join(dir, "bad");
        yield* fs.makeDirectory(goodDir);
        yield* fs.makeDirectory(badDir);
        yield* fs.writeFileString(path.join(goodDir, "a.sql"), "select 1;");
        yield* fs.writeFileString(path.join(badDir, "b.sql"), "select 2;");
        const result = yield* withMode(badDir, 0o000, run(["good", "bad"], dir));
        expect(result.files).toEqual(["good/a.sql"]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatch(/^failed to walk matched directory: /);
      }),
  );

  it.effect.skipIf(isRoot)(
    "picks the lexically-first failing subdirectory as the fatal error, matching Go's fs.WalkDir sorted-visit order (review CLI-1958)",
    () =>
      Effect.gen(function* () {
        // The fake `readDirectory` returns "schemas"'s children in reverse
        // order, to prove the walk sorts them back (`utf8Compare`) before iterating.
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-walk-order-");
        const schemasDir = path.join(dir, "schemas");
        const aaaDir = path.join(schemasDir, "aaa");
        const bbbDir = path.join(schemasDir, "bbb");
        yield* fs.makeDirectory(aaaDir, { recursive: true });
        yield* fs.makeDirectory(bbbDir, { recursive: true });
        const reorderedFs: FileSystem.FileSystem = {
          ...fs,
          readDirectory: (p, opts) =>
            fs
              .readDirectory(p, opts)
              .pipe(
                Effect.map((names) => (p === schemasDir ? [...names].sort().reverse() : names)),
              ),
        };
        const result = yield* withMode(
          aaaDir,
          0o000,
          withMode(bbbDir, 0o000, sqlFilesGlob(reorderedFs, path, ["schemas"], dir)),
        );
        expect(result.files).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("schemas/aaa");
        expect(result.warnings[0]).not.toContain("schemas/bbb");
      }),
  );

  it.effect(
    "sorts direct wildcard matches by UTF-8 byte order, not UTF-16 code units (Go sort.Strings parity)",
    () =>
      Effect.gen(function* () {
        // The emoji (4-byte UTF-8, lead byte 0xF0) sorts after the fullwidth exclamation mark
        // (3-byte UTF-8, lead byte 0xEF) in byte order, but before it in UTF-16 code-unit
        // order (0xD83D surrogate lead vs 0xFF01) — these two characters expose the difference.
        const { fs, path, dir } = yield* tempWorkdir("sql-glob-utf8-sort-");
        const schemasDir = path.join(dir, "schemas");
        yield* fs.makeDirectory(schemasDir);
        yield* fs.writeFileString(path.join(schemasDir, "\u{1F600}.sql"), "select 1;"); // 😀
        yield* fs.writeFileString(path.join(schemasDir, "！.sql"), "select 2;"); // ！
        const result = yield* run(["schemas/*.sql"], dir);
        expect(result.files).toEqual(["schemas/！.sql", "schemas/\u{1F600}.sql"]);
        expect(result.warnings).toEqual([]);
      }),
  );
});
