import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { useTempWorkdir } from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { DeclarativeWriteError } from "./pgdelta.errors.ts";
import type { PgDeltaDeclarativeExportResult } from "./pgdelta-engine.service.ts";
import {
  warnPreservedUnmanagedDeclarativeFiles,
  writeDeclarativeSchemas,
} from "./pgdelta.write.ts";

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
  const declarativeDir = () => join(tmp.current, "supabase", "database");

  it.effect("tracks next-engine ownership while preserving custom and unmanaged files", () => {
    const dir = declarativeDir();
    return Effect.gen(function* () {
      yield* write(
        dir,
        nextOutput([
          { name: "app/tables/z.sql", sql: "select 'z';" },
          { name: "stale.sql", sql: "select 'remove later';" },
        ]),
      );
      mkdirSync(join(dir, "_custom"), { recursive: true });
      writeFileSync(join(dir, "_custom", "casts.sql"), "create cast (int as text);");
      writeFileSync(join(dir, "unmanaged.sql"), "select 'keep me';");

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
      expect(existsSync(join(dir, "stale.sql"))).toBe(false);
      expect(readFileSync(join(dir, "_cluster", "roles.sql"), "utf8")).toBe("create role app;");
      expect(readFileSync(join(dir, "unmanaged.sql"), "utf8")).toBe("select 'keep me';");
      expect(readFileSync(join(dir, "_custom", "casts.sql"), "utf8")).toBe(
        "create cast (int as text);",
      );
      expect(JSON.parse(readFileSync(join(dir, ".pgdelta-export.json"), "utf8"))).toEqual({
        formatVersion: 1,
        redactSecrets: true,
        scope: "database",
        profile: "supabase",
        files: ["_cluster/roles.sql", "app/tables/a.sql", "app/tables/z.sql"],
      });
    });
  });

  it.effect("reports manifestless files that the next writer preserves", () => {
    const dir = declarativeDir();
    mkdirSync(join(dir, "_custom"), { recursive: true });
    writeFileSync(join(dir, "_custom", "casts.sql"), "select 'custom';");
    writeFileSync(join(dir, "legacy-b.sql"), "select 'b';");
    writeFileSync(join(dir, "legacy-a.sql"), "select 'a';");
    writeFileSync(join(dir, "replaced.sql"), "-- old");

    return write(
      dir,
      nextOutput([{ name: "replaced.sql", sql: "create table public.example(id int);" }]),
    ).pipe(
      Effect.tap((written) =>
        Effect.sync(() => {
          expect(written.preservedUnmanagedFiles).toEqual(["legacy-a.sql", "legacy-b.sql"]);
          expect(readFileSync(join(dir, "replaced.sql"), "utf8")).toContain("create table");
        }),
      ),
    );
  });

  it.effect("does not rewrite unchanged next-engine files or manifests", () => {
    const dir = declarativeDir();
    const schemaPath = join(dir, "public", "schema.sql");
    const manifestPath = join(dir, ".pgdelta-export.json");
    const output = nextOutput([
      { name: "public/schema.sql", sql: "create table public.example(id int);" },
    ]);

    return write(dir, output).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const old = new Date("2020-01-01T00:00:00.000Z");
          utimesSync(schemaPath, old, old);
          utimesSync(manifestPath, old, old);
        }),
      ),
      Effect.andThen(write(dir, output)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(statSync(schemaPath).mtime.toISOString()).toBe("2020-01-01T00:00:00.000Z");
          expect(statSync(manifestPath).mtime.toISOString()).toBe("2020-01-01T00:00:00.000Z");
        }),
      ),
    );
  });

  it.effect("rejects reserved and escaping export paths", () =>
    Effect.gen(function* () {
      const reserved = yield* write(
        join(tmp.current, "reserved"),
        nextOutput([{ name: "_custom/generated.sql", sql: "select 1;" }]),
      ).pipe(Effect.flip);
      expect(reserved).toBeInstanceOf(DeclarativeWriteError);
      expect(reserved.message).toContain("reserved declarative schema path");

      const escaping = yield* write(
        join(tmp.current, "escaping"),
        nextOutput([{ name: "../escape.sql", sql: "x" }]),
      ).pipe(Effect.flip);
      expect(escaping).toBeInstanceOf(DeclarativeWriteError);
      expect(escaping.message).toContain("unsafe declarative export path");
    }),
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
