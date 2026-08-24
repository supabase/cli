import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import type { LegacyDeclarativeOutput } from "../../../shared/legacy-pgdelta.ts";
import { LegacyDeclarativeWriteError } from "./legacy-pgdelta.errors.ts";
import type { LegacyPgDeltaDeclarativeExportResult } from "./legacy-pgdelta-engine.service.ts";
import {
  legacyWarnPreservedUnmanagedDeclarativeFiles,
  legacyWriteDeclarativeSchemas,
} from "./legacy-pgdelta.write.ts";

const write = (
  declarativeDir: string,
  output: LegacyDeclarativeOutput | LegacyPgDeltaDeclarativeExportResult,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* legacyWriteDeclarativeSchemas(fs, path, declarativeDir, output);
  });

const nextOutput = (files: LegacyPgDeltaDeclarativeExportResult["files"]) => ({
  files,
  manifest: { redactSecrets: true, scope: "database" as const, profile: "supabase" },
});

describe("legacyWriteDeclarativeSchemas", () => {
  it.effect("keeps the legacy wipe-and-rewrite behavior", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "legacy-decl-write-" });
      const dir = path.join(root, "supabase", "database");
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(path.join(dir, "stale.sql"), "-- should be removed");
      const written = yield* write(dir, {
        version: 1,
        mode: "declarative",
        files: [
          { path: "public.sql", order: 0, statements: 1, sql: "create table a();" },
          { path: "auth/roles.sql", order: 1, statements: 1, sql: "create role app;" },
        ],
      });
      expect(written.preservedUnmanagedFiles).toEqual([]);
      expect(yield* fs.exists(path.join(dir, "stale.sql"))).toBe(false);
      expect(yield* fs.readFileString(path.join(dir, "public.sql"))).toBe("create table a();");
      expect(yield* fs.readFileString(path.join(dir, "auth", "roles.sql"))).toBe(
        "create role app;",
      );
      expect(yield* fs.exists(path.join(dir, ".pgdelta-export.json"))).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("tracks next-engine ownership while preserving custom and unmanaged files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "legacy-decl-write-" });
      const dir = path.join(root, "supabase", "database");
      yield* write(
        dir,
        nextOutput([
          { name: "app/tables/z.sql", sql: "select 'z';" },
          { name: "stale.sql", sql: "select 'remove later';" },
        ]),
      );
      yield* fs.makeDirectory(path.join(dir, "_custom"), { recursive: true });
      yield* fs.writeFileString(
        path.join(dir, "_custom", "casts.sql"),
        "create cast (int as text);",
      );
      yield* fs.writeFileString(path.join(dir, "unmanaged.sql"), "select 'keep me';");

      const written = yield* write(
        dir,
        nextOutput([
          { name: "app/tables/z.sql", sql: "select 'z';" },
          { name: "app/tables/a.sql", sql: "select 'a';" },
          // `_cluster/` is the exporter's reserved root for cluster-level objects
          // (pg-delta >= 1.0.0-alpha.42's flat path style). Unlike `_custom/`, it is
          // owned output: it must be written and tracked like any schema directory.
          { name: "_cluster/roles.sql", sql: "create role app;" },
        ]),
      );

      expect(written.preservedUnmanagedFiles).toEqual([]);
      expect(yield* fs.exists(path.join(dir, "stale.sql"))).toBe(false);
      expect(yield* fs.readFileString(path.join(dir, "_cluster", "roles.sql"))).toBe(
        "create role app;",
      );
      expect(yield* fs.readFileString(path.join(dir, "unmanaged.sql"))).toBe("select 'keep me';");
      expect(yield* fs.readFileString(path.join(dir, "_custom", "casts.sql"))).toBe(
        "create cast (int as text);",
      );
      expect(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* fs.readFileString(path.join(dir, ".pgdelta-export.json")),
        ),
      ).toEqual({
        formatVersion: 1,
        redactSecrets: true,
        scope: "database",
        profile: "supabase",
        files: ["_cluster/roles.sql", "app/tables/a.sql", "app/tables/z.sql"],
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports manifestless files that the next writer preserves", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "legacy-decl-write-" });
      const dir = path.join(root, "supabase", "database");
      yield* fs.makeDirectory(path.join(dir, "_custom"), { recursive: true });
      yield* fs.writeFileString(path.join(dir, "_custom", "casts.sql"), "select 'custom';");
      yield* fs.writeFileString(path.join(dir, "legacy-b.sql"), "select 'b';");
      yield* fs.writeFileString(path.join(dir, "legacy-a.sql"), "select 'a';");
      yield* fs.writeFileString(path.join(dir, "replaced.sql"), "-- old");
      const written = yield* write(
        dir,
        nextOutput([{ name: "replaced.sql", sql: "create table public.example(id int);" }]),
      );
      expect(written.preservedUnmanagedFiles).toEqual(["legacy-a.sql", "legacy-b.sql"]);
      expect(yield* fs.readFileString(path.join(dir, "replaced.sql"))).toContain("create table");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("does not rewrite unchanged next-engine files or manifests", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "legacy-decl-write-" });
      const dir = path.join(root, "supabase", "database");
      const schemaPath = path.join(dir, "public", "schema.sql");
      const manifestPath = path.join(dir, ".pgdelta-export.json");
      const output = nextOutput([
        { name: "public/schema.sql", sql: "create table public.example(id int);" },
      ]);
      yield* write(dir, output);
      const old = DateTime.toDate(DateTime.makeUnsafe({ year: 2020, month: 1, day: 1 }));
      yield* fs.utimes(schemaPath, old, old);
      yield* fs.utimes(manifestPath, old, old);
      yield* write(dir, output);
      const schemaInfo = yield* fs.stat(schemaPath);
      const manifestInfo = yield* fs.stat(manifestPath);
      expect(
        Option.isSome(schemaInfo.mtime) ? schemaInfo.mtime.value.toISOString() : undefined,
      ).toBe("2020-01-01T00:00:00.000Z");
      expect(
        Option.isSome(manifestInfo.mtime) ? manifestInfo.mtime.value.toISOString() : undefined,
      ).toBe("2020-01-01T00:00:00.000Z");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rejects reserved and escaping export paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "legacy-decl-write-" });
      const reserved = yield* write(
        path.join(root, "reserved"),
        nextOutput([{ name: "_custom/generated.sql", sql: "select 1;" }]),
      ).pipe(Effect.flip);
      expect(reserved).toBeInstanceOf(LegacyDeclarativeWriteError);
      expect(reserved.message).toContain("reserved declarative schema path");

      const escaping = yield* write(path.join(root, "escaping"), {
        version: 1,
        mode: "declarative",
        files: [{ path: "../escape.sql", order: 0, statements: 0, sql: "x" }],
      }).pipe(Effect.flip);
      expect(escaping).toBeInstanceOf(LegacyDeclarativeWriteError);
      expect(escaping.message).toContain("unsafe declarative export path");
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("legacyWarnPreservedUnmanagedDeclarativeFiles", () => {
  it.effect("names preserved files and advises a clean regeneration", () => {
    const out = mockOutput();
    return Effect.gen(function* () {
      yield* legacyWarnPreservedUnmanagedDeclarativeFiles("supabase/database", {
        preservedUnmanagedFiles: ["legacy-a.sql", "legacy-b.sql"],
      });
      expect(out.stderrText).toContain(
        "2 existing declarative schema file(s) in supabase/database",
      );
      expect(out.stderrText).toContain("legacy-a.sql, legacy-b.sql");
      expect(out.stderrText).toContain("remove supabase/database and re-run");
    }).pipe(Effect.provide(out.layer));
  });
});
