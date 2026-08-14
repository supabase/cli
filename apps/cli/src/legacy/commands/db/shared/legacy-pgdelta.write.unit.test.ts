import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { useLegacyTempWorkdir } from "../../../../../tests/helpers/legacy-mocks.ts";
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
  }).pipe(Effect.provide(BunServices.layer));

const nextOutput = (files: LegacyPgDeltaDeclarativeExportResult["files"]) => ({
  files,
  manifest: { redactSecrets: true, scope: "database" as const, profile: "supabase" },
});

describe("legacyWriteDeclarativeSchemas", () => {
  const tmp = useLegacyTempWorkdir("legacy-decl-write-");
  const declarativeDir = () => join(tmp.current, "supabase", "database");

  it.effect("keeps the legacy wipe-and-rewrite behavior", () => {
    const dir = declarativeDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stale.sql"), "-- should be removed");
    return write(dir, {
      version: 1,
      mode: "declarative",
      files: [
        { path: "public.sql", order: 0, statements: 1, sql: "create table a();" },
        { path: "auth/roles.sql", order: 1, statements: 1, sql: "create role app;" },
      ],
    }).pipe(
      Effect.tap((written) =>
        Effect.sync(() => {
          expect(written.preservedUnmanagedFiles).toEqual([]);
          expect(existsSync(join(dir, "stale.sql"))).toBe(false);
          expect(readFileSync(join(dir, "public.sql"), "utf8")).toBe("create table a();");
          expect(readFileSync(join(dir, "auth", "roles.sql"), "utf8")).toBe("create role app;");
          expect(existsSync(join(dir, ".pgdelta-export.json"))).toBe(false);
        }),
      ),
    );
  });

  it.effect("tracks next-engine ownership while preserving custom and unmanaged files", () => {
    const dir = declarativeDir();
    return Effect.gen(function* () {
      yield* write(
        dir,
        nextOutput([
          { name: "schemas/z.sql", sql: "select 'z';" },
          { name: "stale.sql", sql: "select 'remove later';" },
        ]),
      );
      mkdirSync(join(dir, "_custom"), { recursive: true });
      writeFileSync(join(dir, "_custom", "casts.sql"), "create cast (int as text);");
      writeFileSync(join(dir, "unmanaged.sql"), "select 'keep me';");

      const written = yield* write(
        dir,
        nextOutput([
          { name: "schemas/z.sql", sql: "select 'z';" },
          { name: "schemas/a.sql", sql: "select 'a';" },
        ]),
      );

      expect(written.preservedUnmanagedFiles).toEqual([]);
      expect(existsSync(join(dir, "stale.sql"))).toBe(false);
      expect(readFileSync(join(dir, "unmanaged.sql"), "utf8")).toBe("select 'keep me';");
      expect(readFileSync(join(dir, "_custom", "casts.sql"), "utf8")).toBe(
        "create cast (int as text);",
      );
      expect(JSON.parse(readFileSync(join(dir, ".pgdelta-export.json"), "utf8"))).toEqual({
        formatVersion: 1,
        redactSecrets: true,
        scope: "database",
        profile: "supabase",
        files: ["schemas/a.sql", "schemas/z.sql"],
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
    const schemaPath = join(dir, "schemas", "public.sql");
    const manifestPath = join(dir, ".pgdelta-export.json");
    const output = nextOutput([
      { name: "schemas/public.sql", sql: "create table public.example(id int);" },
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
      expect(reserved).toBeInstanceOf(LegacyDeclarativeWriteError);
      expect(reserved.message).toContain("reserved declarative schema path");

      const escaping = yield* write(join(tmp.current, "escaping"), {
        version: 1,
        mode: "declarative",
        files: [{ path: "../escape.sql", order: 0, statements: 0, sql: "x" }],
      }).pipe(Effect.flip);
      expect(escaping).toBeInstanceOf(LegacyDeclarativeWriteError);
      expect(escaping.message).toContain("unsafe declarative export path");
    }),
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
