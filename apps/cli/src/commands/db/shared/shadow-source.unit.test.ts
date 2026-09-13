import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, Path, PlatformError } from "effect";

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

function makeWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "shadow-source-"));
}

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
    () => {
      const workdir = makeWorkdir();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta());
        expect(result).toEqual([]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "falls back to sorted supabase/schemas/*.sql when no schema_paths/pg-delta dir apply",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "schemas"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "schemas", "b.sql"), "select 2;\n");
      writeFileSync(join(workdir, "supabase", "schemas", "a.sql"), "select 1;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta());
        expect(result).toEqual(["supabase/schemas/a.sql", "supabase/schemas/b.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "prefers the pg-delta declarative dir over supabase/schemas when pg-delta is enabled and the dir exists",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "database"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "database", "t.sql"), "select 1;\n");
      mkdirSync(join(workdir, "supabase", "schemas"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "schemas", "unused.sql"), "select 2;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
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
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "prefers db.migrations.schema_paths over both the pg-delta dir and supabase/schemas",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "custom"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "custom", "x.sql"), "select 1;\n");
      mkdirSync(join(workdir, "supabase", "database"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "database", "unused.sql"), "select 2;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
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
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect("fails when a literal (non-glob) schema_paths entry matches nothing", () => {
    const workdir = makeWorkdir();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const exit = yield* loadDeclaredSchemas(fs, path, workdir, ["missing.sql"], pgDelta()).pipe(
        Effect.exit,
      );
      expect(exit._tag).toBe("Failure");
      rmSync(workdir, { recursive: true, force: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect(
    'an empty schema_paths entry matches nothing, not the entire project (Go\'s fs.Glob(""))',
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "migrations"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "migrations", "001_init.sql"), "select 1;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* loadDeclaredSchemas(fs, path, workdir, [""], pgDelta()).pipe(
          Effect.exit,
        );
        expect(exit._tag).toBe("Failure");
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect("a glob schema_paths entry matching nothing is silently skipped, not an error", () => {
    const workdir = makeWorkdir();
    mkdirSync(join(workdir, "supabase", "custom"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "custom", "x.sql"), "select 1;\n");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const result = yield* loadDeclaredSchemas(
        fs,
        path,
        workdir,
        ["custom/*.sql", "empty-glob/*.sql"],
        pgDelta(),
      );
      expect(result).toEqual(["supabase/custom/x.sql"]);
      rmSync(workdir, { recursive: true, force: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect(
    "on POSIX, a backslash in a schema_paths entry is a path.Match escape, not a separator (review: PRRT_kwDOErm0O86W7n90)",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "customx.sql"), "select 1;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* loadDeclaredSchemas(fs, path, workdir, ["custom\\x.sql"], pgDelta());
        expect(result).toEqual(["supabase/customx.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "on POSIX, a backslash-escaped glob metacharacter in schema_paths matches the literal filename (review: PRRT_kwDOErm0O86W7n90)",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "foo*.sql"), "select 1;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* loadDeclaredSchemas(fs, path, workdir, ["foo\\*.sql"], pgDelta());
        expect(result).toEqual(["supabase/foo*.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "dedupes a directory schema_paths entry with a trailing separator against a literal-file entry for the same file (review: PRRT_kwDOErm0O86XAlIr)",
    () => {
      // Must use absolute paths: a relative trailing-slash entry gets cleaned before reaching
      // the glob, so only an absolute entry reaches the code path this test exercises.
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "custom"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "custom", "x.sql"), "select 1;\n");
      const absDirWithTrailingSlash = `${join(workdir, "supabase", "custom")}/`;
      const absFile = join(workdir, "supabase", "custom", "x.sql");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* loadDeclaredSchemas(
          fs,
          path,
          workdir,
          [absDirWithTrailingSlash, absFile],
          pgDelta(),
        );
        expect(result).toEqual([absFile]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "excludes a symlinked .sql file from a recursively-matched schema_paths directory",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "custom"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "custom", "real.sql"), "select 1;\n");
      const secretTarget = join(workdir, "outside.sql");
      writeFileSync(secretTarget, "select 2;\n");
      symlinkSync(secretTarget, join(workdir, "supabase", "custom", "linked.sql"));
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* loadDeclaredSchemas(fs, path, workdir, ["custom"], pgDelta());
        expect(result).toEqual(["supabase/custom/real.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect("excludes a symlinked .sql file from the supabase/schemas fallback walk", () => {
    const workdir = makeWorkdir();
    mkdirSync(join(workdir, "supabase", "schemas"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "schemas", "real.sql"), "select 1;\n");
    const secretTarget = join(workdir, "outside.sql");
    writeFileSync(secretTarget, "select 2;\n");
    symlinkSync(secretTarget, join(workdir, "supabase", "schemas", "linked.sql"));
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const result = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta());
      expect(result).toEqual(["supabase/schemas/real.sql"]);
      rmSync(workdir, { recursive: true, force: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect(
    "does not follow a symlinked subdirectory in a recursively-matched schema_paths directory",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "custom"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "custom", "real.sql"), "select 1;\n");
      const outsideDir = join(workdir, "outside");
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, "secret.sql"), "select 2;\n");
      symlinkSync(outsideDir, join(workdir, "supabase", "custom", "linked-dir"), "dir");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* loadDeclaredSchemas(fs, path, workdir, ["custom"], pgDelta());
        expect(result).toEqual(["supabase/custom/real.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "does not follow a symlinked subdirectory in the supabase/schemas fallback walk",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "schemas"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "schemas", "real.sql"), "select 1;\n");
      const outsideDir = join(workdir, "outside");
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, "secret.sql"), "select 2;\n");
      symlinkSync(outsideDir, join(workdir, "supabase", "schemas", "linked-dir"), "dir");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta());
        expect(result).toEqual(["supabase/schemas/real.sql"]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "falls back to supabase/schemas when the pg-delta declarative path exists but is a regular file",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "database"), "not a directory");
      mkdirSync(join(workdir, "supabase", "schemas"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "schemas", "a.sql"), "select 1;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
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
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "returns [] when supabase/schemas exists but is a regular file, not a directory",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "schemas"), "not a directory");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta());
        expect(result).toEqual([]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "returns [] (does not follow) when the pg-delta declarative dir itself is a symlink",
    () => {
      const workdir = makeWorkdir();
      const realDir = join(workdir, "real-database");
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, "t.sql"), "select 1;\n");
      mkdirSync(join(workdir, "supabase"), { recursive: true });
      symlinkSync(realDir, join(workdir, "supabase", "database"), "dir");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
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
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect("returns [] (does not follow) when supabase/schemas itself is a symlink", () => {
    const workdir = makeWorkdir();
    const realDir = join(workdir, "real-schemas");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "t.sql"), "select 1;\n");
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    symlinkSync(realDir, join(workdir, "supabase", "schemas"), "dir");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const result = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta());
      expect(result).toEqual([]);
      rmSync(workdir, { recursive: true, force: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect(
    "sorts declared schema paths by UTF-8 byte order, not JS's default UTF-16 code-unit order",
    () => {
      // U+1F600 (a UTF-16 surrogate pair) sorts before U+E000 under JS's default order, but
      // after it in UTF-8 byte order.
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "schemas"), { recursive: true });
      const supplementary = "a\u{1F600}.sql";
      const privateUse = "a.sql";
      writeFileSync(join(workdir, "supabase", "schemas", supplementary), "select 1;\n");
      writeFileSync(join(workdir, "supabase", "schemas", privateUse), "select 2;\n");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta());
        expect(result).toEqual([
          `supabase/schemas/${privateUse}`,
          `supabase/schemas/${supplementary}`,
        ]);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "propagates (rather than silently drops) a per-entry stat failure during the pg-delta/schemas walk",
    () => {
      const workdir = makeWorkdir();
      mkdirSync(join(workdir, "supabase", "schemas"), { recursive: true });
      writeFileSync(join(workdir, "supabase", "schemas", "a.sql"), "select 1;\n");
      const brokenAbs = join(workdir, "supabase", "schemas", "broken.sql");
      writeFileSync(brokenAbs, "select 2;\n");
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
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta()).pipe(Effect.exit);
        expect(exit._tag).toBe("Failure");
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(statFs));
    },
  );

  it.effect.skipIf(isRoot)(
    "fails (rather than silently treating as empty) when a matched schema directory can't be read, and keeps the underlying cause in the message",
    () => {
      const workdir = makeWorkdir();
      const locked = join(workdir, "supabase", "locked");
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o000);
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* loadDeclaredSchemas(fs, path, workdir, ["locked"], pgDelta()).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = JSON.stringify(exit.cause);
          expect(errorJson).toContain("failed to walk matched directory:");
          expect(errorJson).not.toContain("failed to walk matched directory: locked");
        }
        chmodSync(locked, 0o755);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect.skipIf(isRoot)(
    "visits sibling directories in UTF-8 byte order, not JS's default UTF-16 order, so the reported failure matches Go's (review: PRRT_kwDOErm0O86XAlIo)",
    () => {
      // Byte order visits `dir\u{E000}` before `dir\u{1F600}` (the opposite of JS's default
      // order), so its EACCES failure must be the one that surfaces.
      const workdir = makeWorkdir();
      const matched = join(workdir, "supabase", "custom");
      const utf16First = join(matched, "dir\u{1F600}");
      const byteOrderFirst = join(matched, "dir\u{E000}");
      mkdirSync(utf16First, { recursive: true });
      mkdirSync(byteOrderFirst, { recursive: true });
      chmodSync(utf16First, 0o000);
      chmodSync(byteOrderFirst, 0o000);
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* loadDeclaredSchemas(fs, path, workdir, ["custom"], pgDelta()).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = JSON.stringify(exit.cause);
          expect(errorJson).toContain(byteOrderFirst);
          expect(errorJson).not.toContain(utf16First);
        }
        chmodSync(utf16First, 0o755);
        chmodSync(byteOrderFirst, 0o755);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect.skipIf(isRoot)(
    "reports the pg-delta declarative dir walk failure as 'failed to walk declarative dir', not the generic 'failed to walk dir'",
    () => {
      const workdir = makeWorkdir();
      const declDir = join(workdir, "supabase", "database");
      mkdirSync(declDir, { recursive: true });
      chmodSync(declDir, 0o000);
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
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
          const errorJson = JSON.stringify(exit.cause);
          expect(errorJson).toContain("failed to walk declarative dir:");
          expect(errorJson).not.toContain("failed to walk dir:");
        }
        chmodSync(declDir, 0o755);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect.skipIf(isRoot)(
    "reports the supabase/schemas fallback walk failure as 'failed to walk dir', not the declarative-dir prefix",
    () => {
      const workdir = makeWorkdir();
      const schemasDir = join(workdir, "supabase", "schemas");
      mkdirSync(schemasDir, { recursive: true });
      chmodSync(schemasDir, 0o000);
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const exit = yield* loadDeclaredSchemas(fs, path, workdir, [], pgDelta()).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const errorJson = JSON.stringify(exit.cause);
          expect(errorJson).toContain("failed to walk dir:");
          expect(errorJson).not.toContain("failed to walk declarative dir:");
        }
        chmodSync(schemasDir, 0o755);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );
});
