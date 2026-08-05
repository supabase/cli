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
