import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, Path, PlatformError } from "effect";

import { legacyGlobPattern, legacyResolveUnderWorkdir, legacyWalkSqlFiles } from "./legacy-glob.ts";

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

function fakeFileInfo(type: FileSystem.File.Type): FileSystem.File.Info {
  return {
    type,
    mtime: Option.none(),
    atime: Option.none(),
    birthtime: Option.none(),
    dev: 0,
    ino: Option.none(),
    mode: 0,
    nlink: Option.none(),
    uid: Option.none(),
    gid: Option.none(),
    rdev: Option.none(),
    size: 0n as FileSystem.Size,
    blksize: Option.none(),
    blocks: Option.none(),
  };
}

const notASymlink = (path: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method: "readLink",
    description: `not a symlink: ${path}`,
    pathOrDescriptor: path,
  });

const statFailure = (path: string) =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "stat",
    description: `EACCES: permission denied, stat '${path}'`,
    pathOrDescriptor: path,
  });

/**
 * A `FileSystem.FileSystem` entirely backed by fixed maps: `readDirectory` answers from
 * `entries`, `readLink` always fails (every entry looks like "not a symlink" to
 * `legacyWalkSqlFiles`'s probe), and `stat` answers from `statTypes` — except for
 * `statFailsFor`, which fails, simulating a permission/I/O error reading an entry
 * `readDirectory` just listed (distinct from a benign not-a-symlink `readLink` failure). Every
 * other method is `legacyWalkSqlFiles`-unreachable noise, so it's left as `FileSystem.makeNoop`'s
 * default `NotFound` failure.
 */
function fakeWalkFs(
  entries: Record<string, ReadonlyArray<string>>,
  statTypes: Record<string, FileSystem.File.Type>,
  statFailsFor?: string,
) {
  return Layer.succeed(
    FileSystem.FileSystem,
    FileSystem.makeNoop({
      readDirectory: (dir) => Effect.succeed([...(entries[dir] ?? [])]),
      readLink: (path) => Effect.fail(notASymlink(path)),
      stat: (path) =>
        path === statFailsFor
          ? Effect.fail(statFailure(path))
          : Effect.succeed(fakeFileInfo(statTypes[path] ?? "File")),
    }),
  );
}

describe("legacyWalkSqlFiles", () => {
  it.effect("propagates a stat failure instead of silently treating the entry as absent", () => {
    // Go's `fs.WalkDir` (`walkMatchedDir`, `pkg/config/config.go:194-207`) propagates a
    // per-entry stat/lstat error from its walk callback, aborting `Glob.SQLFiles` entirely —
    // a directory `readDirectory` can list but `stat` then fails to read (permission denied,
    // removed mid-walk, I/O error) must fail the whole walk, not silently resolve to "no file
    // here" (review: PRRT_kwDOErm0O86WXFqr).
    const layer = fakeWalkFs({ "/schemas": ["broken.sql"] }, {}, "/schemas/broken.sql");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exit = yield* Effect.exit(legacyWalkSqlFiles(fs, "/schemas", ""));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("still lists regular .sql files when every stat succeeds", () => {
    const layer = fakeWalkFs(
      { "/schemas": ["a.sql", "b.txt"] },
      { "/schemas/a.sql": "File", "/schemas/b.txt": "File" },
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = yield* legacyWalkSqlFiles(fs, "/schemas", "");
      expect([...files]).toEqual(["a.sql"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("recurses into subdirectories and sorts is left to the caller", () => {
    const layer = fakeWalkFs(
      { "/schemas": ["nested", "top.sql"], "/schemas/nested": ["inner.sql"] },
      {
        "/schemas/nested": "Directory",
        "/schemas/top.sql": "File",
        "/schemas/nested/inner.sql": "File",
      },
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = yield* legacyWalkSqlFiles(fs, "/schemas", "");
      expect([...files].sort()).toEqual(["nested/inner.sql", "top.sql"]);
    }).pipe(Effect.provide(layer));
  });
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
