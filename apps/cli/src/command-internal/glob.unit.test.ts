import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ByteSize, Effect, Exit, FileSystem, Layer, Option, Path, PlatformError } from "effect";

import { compareUtf8Bytes, globPattern, resolveUnderWorkdir, walkSqlFiles } from "./glob.ts";

// Answers `readDirectory` from a fixed map keyed by the requested directory; every other method
// delegates to the real Bun filesystem.
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

describe("globPattern", () => {
  it.effect(
    "globs a root-anchored absolute pattern (/*.sql) against the filesystem root, not the workdir",
    () => {
      const { layer, calls } = fakeReadDirFs({
        "/": ["one.sql", "two.sql", "notes.txt"],
        "/some/workdir": ["should-not-be-read.sql"],
      });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const matches = yield* globPattern(fs, path, "/some/workdir", "/*.sql");
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
      const matches = yield* globPattern(fs, path, "/some/workdir", "*.sql");
      expect([...matches]).toEqual(["a.sql"]);
      expect(calls).toEqual(["/some/workdir"]);
    }).pipe(Effect.provide(Layer.mergeAll(layer, Path.layer)));
  });

  it.effect(
    "globs a Windows drive-root pattern (C:\\*.sql) against the drive root, not the workdir",
    () => {
      // Uses the real Node win32 path module (`BunPath.layerWin32`) so this is deterministic
      // regardless of the host OS running the test.
      const { layer, calls } = fakeReadDirFs({
        "C:": ["x.sql", "y.sql"],
        "D:\\work": ["should-not-be-read.sql"],
      });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const matches = yield* globPattern(fs, path, "D:\\work", "C:\\*.sql");
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
    size: ByteSize.bytes(0),
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

// A `FileSystem.FileSystem` backed by fixed maps: `readDirectory`/`stat` answer from `entries`/
// `statTypes`, `readLink` succeeds only for paths in `symlinks`, and `statFailsFor` makes `stat`
// fail for that one path.
function fakeWalkFs(
  entries: Record<string, ReadonlyArray<string>>,
  statTypes: Record<string, FileSystem.File.Type>,
  statFailsFor?: string,
  symlinks: ReadonlySet<string> = new Set(),
) {
  return Layer.succeed(
    FileSystem.FileSystem,
    FileSystem.makeNoop({
      readDirectory: (dir) => Effect.succeed([...(entries[dir] ?? [])]),
      readLink: (path) =>
        symlinks.has(path) ? Effect.succeed("/somewhere/else") : Effect.fail(notASymlink(path)),
      stat: (path) =>
        path === statFailsFor
          ? Effect.fail(statFailure(path))
          : Effect.succeed(fakeFileInfo(statTypes[path] ?? "File")),
    }),
  );
}

describe("walkSqlFiles", () => {
  it.effect("propagates a stat failure instead of silently treating the entry as absent", () => {
    const layer = fakeWalkFs({ "/schemas": ["broken.sql"] }, {}, "/schemas/broken.sql");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exit = yield* Effect.exit(walkSqlFiles(fs, "/schemas", ""));
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
      const files = yield* walkSqlFiles(fs, "/schemas", "");
      expect([...files]).toEqual(["a.sql"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("recurses into subdirectories, already sorted in Go's byte order", () => {
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
      const files = yield* walkSqlFiles(fs, "/schemas", "");
      expect([...files]).toEqual(["nested/inner.sql", "top.sql"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "sorts by UTF-8 byte order, not JS's default UTF-16 code-unit order (review: PRRT_kwDOErm0O86XAlIo)",
    () => {
      // U+1F600 (a UTF-16 surrogate pair) sorts before U+E000 in JS's default order but after it
      // in byte-wise UTF-8 order.
      const surrogatePair = "a\u{1f600}.sql";
      const privateUse = "a\u{e000}.sql";
      const layer = fakeWalkFs(
        { "/schemas": [surrogatePair, privateUse] },
        { [`/schemas/${surrogatePair}`]: "File", [`/schemas/${privateUse}`]: "File" },
      );
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const files = yield* walkSqlFiles(fs, "/schemas", "");
        expect([...files]).toEqual([privateUse, surrogatePair]);
        expect([...files]).not.toEqual([...files].sort());
        expect([...files]).toEqual([...files].sort(compareUtf8Bytes));
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "does not descend into a symlinked subdirectory (Go's fs.WalkDir/afero.Walk no-follow)",
    () => {
      const layer = fakeWalkFs(
        { "/schemas": ["linked", "top.sql"], "/schemas/linked": ["secret.sql"] },
        { "/schemas/linked": "Directory", "/schemas/top.sql": "File" },
        undefined,
        new Set(["/schemas/linked"]),
      );
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const files = yield* walkSqlFiles(fs, "/schemas", "");
        expect([...files]).toEqual(["top.sql"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("excludes a symlinked .sql file instead of applying its target", () => {
    const layer = fakeWalkFs(
      { "/schemas": ["linked.sql", "top.sql"] },
      { "/schemas/linked.sql": "File", "/schemas/top.sql": "File" },
      undefined,
      new Set(["/schemas/linked.sql"]),
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = yield* walkSqlFiles(fs, "/schemas", "");
      expect([...files]).toEqual(["top.sql"]);
    }).pipe(Effect.provide(layer));
  });
});

describe("resolveUnderWorkdir", () => {
  it.effect(
    "preserves a bare Windows drive-root component instead of joining it under workdir",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(resolveUnderWorkdir(path, "D:\\work", "C:")).toBe("C:");
      }).pipe(Effect.provide(BunPath.layerWin32)),
  );

  it.effect("still joins an ordinary relative segment under workdir on win32", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(resolveUnderWorkdir(path, "D:\\work", "schemas")).toBe("D:\\work\\schemas");
    }).pipe(Effect.provide(BunPath.layerWin32)),
  );
});
