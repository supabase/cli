import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect";

import { useTempWorkdir } from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { DeclarativeWriteError } from "./pgdelta.errors.ts";
import type { PgDeltaDeclarativeExportResult } from "./pgdelta-engine.service.ts";
import {
  warnPreservedUnmanagedDeclarativeFiles,
  writeDeclarativeSchemas,
} from "./pgdelta.write.ts";

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);

const write = (declarativeDir: string, output: PgDeltaDeclarativeExportResult) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* writeDeclarativeSchemas(fs, path, declarativeDir, output);
  }).pipe(Effect.provide(BunServices.layer));

const nextOutput = (files: PgDeltaDeclarativeExportResult["files"]) => ({
  files,
  manifest: { redactSecrets: true, scope: "database" as const, profile: "supabase" },
});

describe("writeDeclarativeSchemas", () => {
  const tmp = useTempWorkdir("decl-write-");
  const declarativeDir = Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(tmp.current, "supabase", "database");
  });

  it.effect("tracks next-engine ownership while preserving custom and unmanaged files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* declarativeDir;
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
      const manifest = yield* fs
        .readFileString(path.join(dir, ".pgdelta-export.json"))
        .pipe(Effect.flatMap(Schema.decodeEffect(UnknownFromJsonString)));
      expect(manifest).toEqual({
        formatVersion: 1,
        redactSecrets: true,
        scope: "database",
        profile: "supabase",
        files: ["_cluster/roles.sql", "app/tables/a.sql", "app/tables/z.sql"],
      });
      expect(yield* fs.readFileString(path.join(dir, ".pgdelta-export.json"))).toBe(`{
  "formatVersion": 1,
  "redactSecrets": true,
  "scope": "database",
  "profile": "supabase",
  "files": [
    "_cluster/roles.sql",
    "app/tables/a.sql",
    "app/tables/z.sql"
  ]
}
`);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("reports manifestless files that the next writer preserves", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* declarativeDir;
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
      const dir = yield* declarativeDir;
      const schemaPath = path.join(dir, "public", "schema.sql");
      const manifestPath = path.join(dir, ".pgdelta-export.json");
      const output = nextOutput([
        { name: "public/schema.sql", sql: "create table public.example(id int);" },
      ]);
      const mtimeIso = (file: string) =>
        fs.stat(file).pipe(Effect.map((info) => Option.map(info.mtime, (d) => d.toISOString())));

      yield* write(dir, output);
      const old = DateTime.toDateUtc(DateTime.makeUnsafe("2020-01-01T00:00:00.000Z"));
      yield* fs.utimes(schemaPath, old, old);
      yield* fs.utimes(manifestPath, old, old);
      yield* write(dir, output);

      expect(yield* mtimeIso(schemaPath)).toEqual(Option.some("2020-01-01T00:00:00.000Z"));
      expect(yield* mtimeIso(manifestPath)).toEqual(Option.some("2020-01-01T00:00:00.000Z"));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("rejects reserved and escaping export paths", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const reserved = yield* write(
        path.join(tmp.current, "reserved"),
        nextOutput([{ name: "_custom/generated.sql", sql: "select 1;" }]),
      ).pipe(Effect.flip);
      expect(reserved).toBeInstanceOf(DeclarativeWriteError);
      expect(reserved.message).toContain("reserved declarative schema path");

      const escaping = yield* write(
        path.join(tmp.current, "escaping"),
        nextOutput([{ name: "../escape.sql", sql: "x" }]),
      ).pipe(Effect.flip);
      expect(escaping).toBeInstanceOf(DeclarativeWriteError);
      expect(escaping.message).toContain("unsafe declarative export path");
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("warnPreservedUnmanagedDeclarativeFiles", () => {
  it.effect("names preserved files and advises a clean regeneration", () => {
    const out = mockOutput();
    return Effect.gen(function* () {
      yield* warnPreservedUnmanagedDeclarativeFiles("supabase/database", {
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
