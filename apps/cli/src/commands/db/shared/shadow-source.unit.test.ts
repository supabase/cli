import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, PlatformError } from "effect";

import { cleanSchemaPath, loadDeclaredSchemas } from "./shadow-source.ts";
import type { PgDeltaTomlConfig } from "../../../command-internal/db-config.toml-read.ts";

function pgDelta(overrides: Partial<PgDeltaTomlConfig> = {}): PgDeltaTomlConfig {
  return {
    enabled: false,
    declarativeSchemaPath: Option.none(),
    formatOptions: Option.none(),
    ...overrides,
  };
}

const makeWorkdir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "shadow-source-" });
});

const lockDirectory = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.chmod(dir, 0o000);
  yield* Effect.addFinalizer(() => fs.chmod(dir, 0o755).pipe(Effect.ignore));
});

// Root bypasses POSIX permission bits, so chmod 000 wouldn't block readdir() there.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("cleanSchemaPath", () => {
  it("preserves a UNC host+share prefix on win32, matching Go's Clean", () => {
    expect(cleanSchemaPath("\\\\server\\share\\schemas", "win32")).toBe("//server/share/schemas");
  });

  it("cleans `.`/`..` segments AFTER a UNC prefix without touching the prefix itself", () => {
    expect(cleanSchemaPath("\\\\server\\share\\a\\.\\b\\..\\c", "win32")).toBe(
      "//server/share/a/c",
    );
  });

  it("drops a leading `..` past a UNC share root instead of climbing above it", () => {
    expect(cleanSchemaPath("\\\\server\\share\\..\\schemas", "win32")).toBe(
      "//server/share/schemas",
    );
  });

  it("leaves a bare UNC share (no subpath) unchanged", () => {
    expect(cleanSchemaPath("\\\\server\\share", "win32")).toBe("//server/share");
  });

  it("does not confuse a UNC path with the distinct root-relative path of the same tail", () => {
    expect(cleanSchemaPath("\\\\server\\share\\schemas", "win32")).not.toBe(
      cleanSchemaPath("/server/share/schemas", "win32"),
    );
  });

  it("still cleans a drive-letter path correctly", () => {
    expect(cleanSchemaPath("C:\\foo\\..\\bar", "win32")).toBe("C:/bar");
  });

  it("does not treat a doubled separator as a UNC volume off win32", () => {
    expect(cleanSchemaPath("//server/share/schemas", "darwin")).toBe("/server/share/schemas");
  });
});

describe("loadDeclaredSchemas", () => {
  it.effect(
    "returns [] when neither schema_paths, an enabled pg-delta dir, nor supabase/schemas exist",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        const result = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta());
        expect(result).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "falls back to sorted supabase/schemas/*.sql when no schema_paths/pg-delta dir apply",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        yield* fs.makeDirectory(path.join(workdir, "supabase", "schemas"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "schemas", "b.sql"),
          "select 2;\n",
        );
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "schemas", "a.sql"),
          "select 1;\n",
        );
        const result = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta());
        expect(result).toEqual(["supabase/schemas/a.sql", "supabase/schemas/b.sql"]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "prefers the pg-delta declarative dir over supabase/schemas when pg-delta is enabled and the dir exists",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        yield* fs.makeDirectory(path.join(workdir, "supabase", "database"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "database", "t.sql"),
          "select 1;\n",
        );
        yield* fs.makeDirectory(path.join(workdir, "supabase", "schemas"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "schemas", "unused.sql"),
          "select 2;\n",
        );
        const result = yield* loadDeclaredSchemas(
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
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "prefers db.migrations.schema_paths over both the pg-delta dir and supabase/schemas",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        yield* fs.makeDirectory(path.join(workdir, "supabase", "custom"), { recursive: true });
        yield* fs.writeFileString(path.join(workdir, "supabase", "custom", "x.sql"), "select 1;\n");
        yield* fs.makeDirectory(path.join(workdir, "supabase", "database"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "database", "unused.sql"),
          "select 2;\n",
        );
        const result = yield* loadDeclaredSchemas(
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
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("fails when a literal (non-glob) schema_paths entry matches nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workdir = yield* makeWorkdir;
      const exit = yield* loadDeclaredSchemas(fs, path, workdir, ["missing.sql"], pgDelta()).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    'an empty schema_paths entry matches nothing, not the entire project (Go\'s fs.Glob(""))',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        yield* fs.makeDirectory(path.join(workdir, "supabase", "migrations"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "migrations", "001_init.sql"),
          "select 1;\n",
        );
        const exit = yield* loadDeclaredSchemas(fs, path, workdir, [""], pgDelta()).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("a glob schema_paths entry matching nothing is silently skipped, not an error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workdir = yield* makeWorkdir;
      yield* fs.makeDirectory(path.join(workdir, "supabase", "custom"), { recursive: true });
      yield* fs.writeFileString(path.join(workdir, "supabase", "custom", "x.sql"), "select 1;\n");
      const result = yield* loadDeclaredSchemas(
        fs,
        path,
        workdir,
        ["custom/*.sql", "empty-glob/*.sql"],
        pgDelta(),
      );
      expect(result).toEqual(["supabase/custom/x.sql"]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "on POSIX, a backslash in a schema_paths entry is a path.Match escape, not a separator (review: PRRT_kwDOErm0O86W7n90)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(workdir, "supabase", "customx.sql"), "select 1;\n");
        const result = yield* loadDeclaredSchemas(fs, path, workdir, ["custom\\x.sql"], pgDelta());
        expect(result).toEqual(["supabase/customx.sql"]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "on POSIX, a backslash-escaped glob metacharacter in schema_paths matches the literal filename (review: PRRT_kwDOErm0O86W7n90)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(workdir, "supabase", "foo*.sql"), "select 1;\n");
        const result = yield* loadDeclaredSchemas(fs, path, workdir, ["foo\\*.sql"], pgDelta());
        expect(result).toEqual(["supabase/foo*.sql"]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "dedupes a directory schema_paths entry with a trailing separator against a literal-file entry for the same file (review: PRRT_kwDOErm0O86XAlIr)",
    () =>
      Effect.gen(function* () {
        // Must use absolute paths: a relative trailing-slash entry gets cleaned before reaching
        // the glob, so only an absolute entry reaches the code path this test exercises.
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        yield* fs.makeDirectory(path.join(workdir, "supabase", "custom"), { recursive: true });
        yield* fs.writeFileString(path.join(workdir, "supabase", "custom", "x.sql"), "select 1;\n");
        const absDirWithTrailingSlash = `${path.join(workdir, "supabase", "custom")}/`;
        const absFile = path.join(workdir, "supabase", "custom", "x.sql");
        const result = yield* loadDeclaredSchemas(
          fs,
          path,
          workdir,
          [absDirWithTrailingSlash, absFile],
          pgDelta(),
        );
        expect(result).toEqual([absFile]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "excludes a symlinked .sql file from a recursively-matched schema_paths directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        yield* fs.makeDirectory(path.join(workdir, "supabase", "custom"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "custom", "real.sql"),
          "select 1;\n",
        );
        const secretTarget = path.join(workdir, "outside.sql");
        yield* fs.writeFileString(secretTarget, "select 2;\n");
        yield* fs.symlink(secretTarget, path.join(workdir, "supabase", "custom", "linked.sql"));
        const result = yield* loadDeclaredSchemas(fs, path, workdir, ["custom"], pgDelta());
        expect(result).toEqual(["supabase/custom/real.sql"]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("excludes a symlinked .sql file from the supabase/schemas fallback walk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workdir = yield* makeWorkdir;
      yield* fs.makeDirectory(path.join(workdir, "supabase", "schemas"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workdir, "supabase", "schemas", "real.sql"),
        "select 1;\n",
      );
      const secretTarget = path.join(workdir, "outside.sql");
      yield* fs.writeFileString(secretTarget, "select 2;\n");
      yield* fs.symlink(secretTarget, path.join(workdir, "supabase", "schemas", "linked.sql"));
      const result = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta());
      expect(result).toEqual(["supabase/schemas/real.sql"]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "does not follow a symlinked subdirectory in a recursively-matched schema_paths directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        yield* fs.makeDirectory(path.join(workdir, "supabase", "custom"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "custom", "real.sql"),
          "select 1;\n",
        );
        const outsideDir = path.join(workdir, "outside");
        yield* fs.makeDirectory(outsideDir, { recursive: true });
        yield* fs.writeFileString(path.join(outsideDir, "secret.sql"), "select 2;\n");
        yield* fs.symlink(outsideDir, path.join(workdir, "supabase", "custom", "linked-dir"));
        const result = yield* loadDeclaredSchemas(fs, path, workdir, ["custom"], pgDelta());
        expect(result).toEqual(["supabase/custom/real.sql"]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("does not follow a symlinked subdirectory in the supabase/schemas fallback walk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workdir = yield* makeWorkdir;
      yield* fs.makeDirectory(path.join(workdir, "supabase", "schemas"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workdir, "supabase", "schemas", "real.sql"),
        "select 1;\n",
      );
      const outsideDir = path.join(workdir, "outside");
      yield* fs.makeDirectory(outsideDir, { recursive: true });
      yield* fs.writeFileString(path.join(outsideDir, "secret.sql"), "select 2;\n");
      yield* fs.symlink(outsideDir, path.join(workdir, "supabase", "schemas", "linked-dir"));
      const result = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta());
      expect(result).toEqual(["supabase/schemas/real.sql"]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "falls back to supabase/schemas when the pg-delta declarative path exists but is a regular file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(workdir, "supabase", "database"), "not a directory");
        yield* fs.makeDirectory(path.join(workdir, "supabase", "schemas"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "schemas", "a.sql"),
          "select 1;\n",
        );
        const result = yield* loadDeclaredSchemas(
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
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("returns [] when supabase/schemas exists but is a regular file, not a directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workdir = yield* makeWorkdir;
      yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(workdir, "supabase", "schemas"), "not a directory");
      const result = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta());
      expect(result).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "returns [] (does not follow) when the pg-delta declarative dir itself is a symlink",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        const realDir = path.join(workdir, "real-database");
        yield* fs.makeDirectory(realDir, { recursive: true });
        yield* fs.writeFileString(path.join(realDir, "t.sql"), "select 1;\n");
        yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
        yield* fs.symlink(realDir, path.join(workdir, "supabase", "database"));
        const result = yield* loadDeclaredSchemas(
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
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("returns [] (does not follow) when supabase/schemas itself is a symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workdir = yield* makeWorkdir;
      const realDir = path.join(workdir, "real-schemas");
      yield* fs.makeDirectory(realDir, { recursive: true });
      yield* fs.writeFileString(path.join(realDir, "t.sql"), "select 1;\n");
      yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
      yield* fs.symlink(realDir, path.join(workdir, "supabase", "schemas"));
      const result = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta());
      expect(result).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "sorts declared schema paths by UTF-8 byte order, not JS's default UTF-16 code-unit order",
    () =>
      Effect.gen(function* () {
        // U+1F600 (a UTF-16 surrogate pair) sorts before U+E000 under JS's default order, but
        // after it in UTF-8 byte order.
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        yield* fs.makeDirectory(path.join(workdir, "supabase", "schemas"), { recursive: true });
        const supplementary = "a\u{1F600}.sql";
        const privateUse = "a\u{E000}.sql";
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "schemas", supplementary),
          "select 1;\n",
        );
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "schemas", privateUse),
          "select 2;\n",
        );
        const result = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta());
        expect(result).toEqual([
          `supabase/schemas/${privateUse}`,
          `supabase/schemas/${supplementary}`,
        ]);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "propagates (rather than silently drops) a per-entry stat failure during the pg-delta/schemas walk",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        yield* fs.makeDirectory(path.join(workdir, "supabase", "schemas"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workdir, "supabase", "schemas", "a.sql"),
          "select 1;\n",
        );
        const brokenAbs = path.join(workdir, "supabase", "schemas", "broken.sql");
        yield* fs.writeFileString(brokenAbs, "select 2;\n");
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
        const exit = yield* Effect.gen(function* () {
          const failingFs = yield* FileSystem.FileSystem;
          const failingPath = yield* Path.Path;
          return yield* loadDeclaredSchemas(failingFs, failingPath, workdir, [], pgDelta()).pipe(
            Effect.exit,
          );
        }).pipe(Effect.provide(statFs));
        expect(Exit.isFailure(exit)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect.skipIf(isRoot)(
    "fails (rather than silently treating as empty) when a matched schema directory can't be read, and keeps the underlying cause in the message",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        const locked = path.join(workdir, "supabase", "locked");
        yield* fs.makeDirectory(locked, { recursive: true });
        yield* lockDirectory(locked);
        const exit = yield* loadDeclaredSchemas(fs, path, workdir, ["locked"], pgDelta()).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("failed to walk matched directory:");
          expect(causeText).not.toContain("failed to walk matched directory: locked");
        }
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect.skipIf(isRoot)(
    "visits sibling directories in UTF-8 byte order, not JS's default UTF-16 order, so the reported failure matches Go's (review: PRRT_kwDOErm0O86XAlIo)",
    () =>
      Effect.gen(function* () {
        // Byte order visits `dir\u{E000}` before `dir\u{1F600}` (the opposite of JS's default
        // order), so its EACCES failure must be the one that surfaces.
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        const matched = path.join(workdir, "supabase", "custom");
        const utf16First = path.join(matched, "dir\u{1F600}");
        const byteOrderFirst = path.join(matched, "dir\u{E000}");
        yield* fs.makeDirectory(utf16First, { recursive: true });
        yield* fs.makeDirectory(byteOrderFirst, { recursive: true });
        yield* lockDirectory(utf16First);
        yield* lockDirectory(byteOrderFirst);
        const exit = yield* loadDeclaredSchemas(fs, path, workdir, ["custom"], pgDelta()).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain(byteOrderFirst);
          expect(causeText).not.toContain(utf16First);
        }
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect.skipIf(isRoot)(
    "reports the pg-delta declarative dir walk failure as 'failed to walk declarative dir', not the generic 'failed to walk dir'",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        const declDir = path.join(workdir, "supabase", "database");
        yield* fs.makeDirectory(declDir, { recursive: true });
        yield* lockDirectory(declDir);
        const exit = yield* loadDeclaredSchemas(
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
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("failed to walk declarative dir:");
          expect(causeText).not.toContain("failed to walk dir:");
        }
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect.skipIf(isRoot)(
    "reports the supabase/schemas fallback walk failure as 'failed to walk dir', not the declarative-dir prefix",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workdir = yield* makeWorkdir;
        const schemasDir = path.join(workdir, "supabase", "schemas");
        yield* fs.makeDirectory(schemasDir, { recursive: true });
        yield* lockDirectory(schemasDir);
        const exit = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta()).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("failed to walk dir:");
          expect(causeText).not.toContain("failed to walk declarative dir:");
        }
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
