import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { legacyGlobPattern, legacyResolveUnderWorkdir } from "./legacy-glob.ts";

/**
 * A `FileSystem.FileSystem` that answers `readDirectory` from a fixed map (keyed by the exact
 * directory string `legacyGlobPattern` asks for) instead of touching the real filesystem — lets
 * these tests assert Go's root-vs-workdir distinction (`Glob{"/*"}.Files(fsys)` reads the fsys
 * root, not the cwd `afero.NewOsFs()` happens to be `chdir`-ed into) without depending on what's
 * actually present at the real OS root. Every other `FileSystem` method delegates to the real
 * Bun filesystem (unused by `legacyGlobPattern`'s glob-meta branch, which only calls
 * `readDirectory`).
 */
function fakeReadDirFs(entries: Record<string, ReadonlyArray<string>>) {
  const calls: Array<string> = [];
  const layer = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (real) =>
      FileSystem.FileSystem.of({
        ...real,
        readDirectory: (dir) => {
          calls.push(dir);
          return Effect.succeed([...(entries[dir] ?? [])]);
        },
      }),
    ),
  ).pipe(Layer.provide(BunFileSystem.layer));
  return { layer, calls };
}

describe("legacyGlobPattern", () => {
  it.effect(
    "globs a root-anchored absolute pattern (/*.sql) against the filesystem root, not the workdir",
    () => {
      // Go's `path.Split`/`cleanGlobPath` (`io/fs/glob.go`) reduce `/*.sql` to a bare `/`
      // directory — confirmed empirically against the real Go CLI's own (unrooted)
      // `afero.NewOsFs()`: `config.Glob{"/*"}.Files(fsys)` lists the actual filesystem root's
      // entries, each still `/`-prefixed, never the process's cwd.
      const { layer, calls } = fakeReadDirFs({
        "/": ["one.sql", "two.sql", "notes.txt"],
        "/some/workdir": ["should-not-be-read.sql"],
      });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const matches = yield* legacyGlobPattern(fs, path, "/some/workdir", "/*.sql");
        expect([...matches].sort()).toEqual(["/one.sql", "/two.sql"]);
        expect(calls).toEqual(["/"]);
      }).pipe(Effect.provide(Layer.mergeAll(layer, Path.layer)));
    },
  );

  it.effect("resolves a plain relative pattern (*.sql) under the workdir, unaffected", () => {
    const { layer, calls } = fakeReadDirFs({
      "/some/workdir": ["a.sql", "b.txt"],
      "/": ["should-not-be-read.sql"],
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const matches = yield* legacyGlobPattern(fs, path, "/some/workdir", "*.sql");
      expect([...matches]).toEqual(["a.sql"]);
      expect(calls).toEqual(["/some/workdir"]);
    }).pipe(Effect.provide(Layer.mergeAll(layer, Path.layer)));
  });

  it.effect(
    "globs a Windows drive-root pattern (C:\\*.sql) against the drive root, not the workdir",
    () => {
      // Mirrors the POSIX root case one level up: Go's split also collapses a drive-root
      // pattern to a bare `C:` directory component (`filepath.ToSlash` turns `C:\*.sql` into
      // `C:/*.sql` first, then the SAME `path.Split`/`cleanGlobPath` logic applies) — still
      // part of the same already-absolute pattern, never something to join under the workdir.
      // Uses the real Node win32 path module (via `BunPath.layerWin32`) so this is deterministic
      // regardless of the host OS running the test.
      const { layer, calls } = fakeReadDirFs({
        "C:": ["x.sql", "y.sql"],
        "D:\\work": ["should-not-be-read.sql"],
      });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const matches = yield* legacyGlobPattern(fs, path, "D:\\work", "C:\\*.sql");
        expect([...matches].sort()).toEqual(["C:/x.sql", "C:/y.sql"]);
        expect(calls).toEqual(["C:"]);
      }).pipe(Effect.provide(Layer.mergeAll(layer, BunPath.layerWin32)));
    },
  );
});

describe("legacyResolveUnderWorkdir", () => {
  it.effect(
    "preserves a bare Windows drive-root component instead of joining it under workdir",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(legacyResolveUnderWorkdir(path, "D:\\work", "C:")).toBe("C:");
      }).pipe(Effect.provide(BunPath.layerWin32)),
  );

  it.effect("still joins an ordinary relative segment under workdir on win32", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(legacyResolveUnderWorkdir(path, "D:\\work", "schemas")).toBe("D:\\work\\schemas");
    }).pipe(Effect.provide(BunPath.layerWin32)),
  );
});
