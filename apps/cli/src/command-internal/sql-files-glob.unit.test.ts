import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath, BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { sqlFilesGlob } from "./sql-files-glob.ts";

const run = (patterns: ReadonlyArray<string>, workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* sqlFilesGlob(fs, path, patterns, workdir);
  }).pipe(Effect.provide(BunServices.layer));

describe("sqlFilesGlob", () => {
  it.effect(
    "treats an empty pattern as no match, not the workdir itself (Go fs.Glob parity)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-empty-"));
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
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-symlink-file-"));
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
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-symlink-dir-"));
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
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-stat-fail-"));
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
    "surfaces a stat failure for a LITERAL (no-metacharacter) pattern naming a broken symlink, instead of reporting no match (Go afero.Glob Lstat parity)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-literal-symlink-"));
      const schemasDir = join(dir, "schemas");
      mkdirSync(schemasDir);
      symlinkSync(join(schemasDir, "does-not-exist.sql"), join(schemasDir, "broken.sql"));
      return run(["schemas/broken.sql"], dir).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual([]);
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toMatch(/^failed to stat matched file: /);
            expect(result.warnings[0]).toContain("schemas/broken.sql");
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "keeps a bare root ('/') as the directory when a glob pattern's meta character is in the first path component (Go afero.Glob parity)",
    () => {
      // The canary file lives in the workdir (never the real "/"), proving this doesn't
      // fall back to treating the root component as workdir-relative.
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-abs-root-"));
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
      // The workdir here contains a subdirectory that would match "foo*" only if the
      // recursive call incorrectly fell back to reading the workdir instead of "/".
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-abs-root-nested-"));
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
      // Forces win32 path semantics (`BunPath.layerWin32` + `process.platform`) so the test
      // exercises the same branch a real Windows install takes.
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-drive-root-"));
      writeFileSync(join(dir, "a.sql"), "select 1;");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // A "C:/" drive root doesn't exist on this test host, so fake just the two calls that
        // must resolve against it, reusing a real file's stat info.
        const realFileInfo = yield* fs.stat(join(dir, "a.sql"));
        const driveRootFs: FileSystem.FileSystem = {
          ...fs,
          readDirectory: (p: string) =>
            p === "C:/" ? Effect.succeed(["a.sql"]) : fs.readDirectory(p),
          stat: (p: string) => (p === "C:/a.sql" ? Effect.succeed(realFileInfo) : fs.stat(p)),
        };
        return yield* sqlFilesGlob(driveRootFs, path, ["C:/*.sql"], dir);
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
      // Forces win32 path semantics, same as the drive-root test above.
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-win-warn-"));
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        return yield* sqlFilesGlob(fs, path, ["C:\\schemas\\*.sql"], dir);
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
      // For `a\x.sql` vs `a0\x.sql`, sorting the raw backslash bytes puts `a0\x.sql` first
      // (`\` is `0x5C` > `0`'s `0x30`), while sorting the slashed form would put `a/x.sql`
      // first instead — a fully faked filesystem supplies canned results keyed by the exact
      // backslash-joined paths `BunPath.layerWin32`'s `path.join` computes.
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      const scratchDir = mkdtempSync(join(tmpdir(), "sql-glob-win-sort-"));
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
        return yield* sqlFilesGlob(winFs, path, ["a*/x.sql"], workdir);
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
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-trailing-slash-"));
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
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-dot-root-"));
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
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-dotdot-segment-"));
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
      // Distinct from the walked-child cleaning tests above: the glob metacharacter is in
      // the final component, so this matches directly via `globOne`, never `walkSqlFiles`.
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-direct-dot-segment-"));
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
      // Same distinction as above (a direct match via `globOne`), but for an embedded `..`
      // segment instead of `.`.
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-direct-dotdot-segment-"));
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
      // `splitPath` on `"schemas//*.sql"` yields `dir: "schemas/"` (the trailing slash
      // survives the split), so the join must still collapse the doubled slash.
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-direct-doubled-slash-"));
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
      // Simulates the race by deleting the file the instant after `readDirectory` returns
      // it, via a `FileSystem` layer that removes on the first `stat` call for that path.
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-stat-race-"));
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
        return yield* sqlFilesGlob(racyFs, path, ["schemas"], dir);
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
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-dir-race-"));
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
        return yield* sqlFilesGlob(racyFs, path, ["schemas"], dir);
      }).pipe(
        Effect.provide(BunServices.layer),
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.files).toEqual([]);
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toMatch(/^failed to walk matched directory: /);
            expect(result.warnings[0]).toContain("schemas/nested");
            expect(result.warnings[0]).not.toContain(dir);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("still expands a real (non-symlinked) nested directory recursively", () => {
    const dir = mkdtempSync(join(tmpdir(), "sql-glob-nested-"));
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
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-walk-fail-"));
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
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-walk-fail-nested-"));
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
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-walk-fail-partial-"));
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

  it.effect.skipIf(isRoot)(
    "picks the lexically-first failing subdirectory as the fatal error, matching Go's fs.WalkDir sorted-visit order (review CLI-1958)",
    () => {
      // The fake `readDirectory` returns "schemas"'s children in reverse
      // order, to prove the walk sorts them back (`utf8Compare`) before iterating.
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-walk-order-"));
      const schemasDir = join(dir, "schemas");
      const aaaDir = join(schemasDir, "aaa");
      const bbbDir = join(schemasDir, "bbb");
      mkdirSync(aaaDir, { recursive: true });
      mkdirSync(bbbDir, { recursive: true });
      chmodSync(aaaDir, 0o000);
      chmodSync(bbbDir, 0o000);
      return Effect.gen(function* () {
        const realFs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const reorderedFs: FileSystem.FileSystem = {
          ...realFs,
          readDirectory: (p, opts) =>
            realFs
              .readDirectory(p, opts)
              .pipe(
                Effect.map((names) => (p === schemasDir ? [...names].sort().reverse() : names)),
              ),
        };
        const result = yield* sqlFilesGlob(reorderedFs, path, ["schemas"], dir);
        expect(result.files).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain("schemas/aaa");
        expect(result.warnings[0]).not.toContain("schemas/bbb");
      }).pipe(
        Effect.provide(BunServices.layer),
        Effect.ensuring(
          Effect.sync(() => {
            chmodSync(aaaDir, 0o755);
            chmodSync(bbbDir, 0o755);
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "sorts direct wildcard matches by UTF-8 byte order, not UTF-16 code units (Go sort.Strings parity)",
    () => {
      // The emoji (4-byte UTF-8, lead byte 0xF0) sorts after the fullwidth exclamation mark
      // (3-byte UTF-8, lead byte 0xEF) in byte order, but before it in UTF-16 code-unit
      // order (0xD83D surrogate lead vs 0xFF01) — these two characters expose the difference.
      const dir = mkdtempSync(join(tmpdir(), "sql-glob-utf8-sort-"));
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
