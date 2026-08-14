import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Path } from "effect";

import { legacyBold } from "../../../shared/legacy-colors.ts";
import type { LegacyDeclarativeOutput } from "../../../shared/legacy-pgdelta.ts";
import { LegacyDeclarativeWriteError } from "./legacy-pgdelta.errors.ts";
import type { LegacyPgDeltaDeclarativeExportResult } from "./legacy-pgdelta-engine.service.ts";
import {
  legacyDeclarativeSchemaWrittenLine,
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

describe("legacyWriteDeclarativeSchemas", () => {
  it.effect("wipes the dir and writes each file at its relative path", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-write-"));
    const declDir = join(dir, "supabase", "database");
    mkdirSync(declDir, { recursive: true });
    writeFileSync(join(declDir, "stale.sql"), "-- should be removed");
    const output: LegacyDeclarativeOutput = {
      version: 1,
      mode: "declarative",
      files: [
        { path: "public.sql", order: 0, statements: 1, sql: "create table a();" },
        { path: "auth/roles.sql", order: 1, statements: 1, sql: "create role app;" },
      ],
    };
    return write(declDir, output).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(existsSync(join(declDir, "stale.sql"))).toBe(false);
          expect(readFileSync(join(declDir, "public.sql"), "utf8")).toBe("create table a();");
          expect(readFileSync(join(declDir, "auth", "roles.sql"), "utf8")).toBe("create role app;");
          expect(existsSync(join(declDir, ".pgdelta-export.json"))).toBe(false);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("writes the next export manifest with the generated file list", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-write-"));
    const declDir = join(dir, "supabase", "database");
    return write(declDir, {
      files: [
        { name: "schemas/z.sql", sql: "select 'z';" },
        { name: "schemas/a.sql", sql: "select 'a';" },
      ],
      manifest: { redactSecrets: true, scope: "database", profile: "supabase" },
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(JSON.parse(readFileSync(join(declDir, ".pgdelta-export.json"), "utf8"))).toEqual({
            formatVersion: 1,
            redactSecrets: true,
            scope: "database",
            profile: "supabase",
            files: ["schemas/a.sql", "schemas/z.sql"],
          });
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("preserves custom and unmanaged files while pruning stale owned files", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-write-"));
    const declDir = join(dir, "supabase", "database");
    mkdirSync(join(declDir, "_custom"), { recursive: true });
    writeFileSync(join(declDir, "_custom", "casts.sql"), "create cast (int as text);");
    writeFileSync(join(declDir, "unmanaged.sql"), "select 'keep me';");
    writeFileSync(join(declDir, "stale.sql"), "select 'remove me';");
    writeFileSync(
      join(declDir, ".pgdelta-export.json"),
      `${JSON.stringify({
        formatVersion: 1,
        redactSecrets: true,
        scope: "database",
        files: ["stale.sql"],
      })}\n`,
    );

    return write(declDir, {
      files: [{ name: "schemas/public.sql", sql: "create table public.example(id int);" }],
      manifest: { redactSecrets: true, scope: "database", profile: "supabase" },
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(existsSync(join(declDir, "stale.sql"))).toBe(false);
          expect(readFileSync(join(declDir, "unmanaged.sql"), "utf8")).toBe("select 'keep me';");
          expect(readFileSync(join(declDir, "_custom", "casts.sql"), "utf8")).toBe(
            "create cast (int as text);",
          );
          expect(
            JSON.parse(readFileSync(join(declDir, ".pgdelta-export.json"), "utf8")).files,
          ).toEqual(["schemas/public.sql"]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("does not rewrite unchanged next-engine files or manifests", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-write-"));
    const declDir = join(dir, "supabase", "database");
    const schemaPath = join(declDir, "schemas", "public.sql");
    const manifestPath = join(declDir, ".pgdelta-export.json");
    const output: LegacyPgDeltaDeclarativeExportResult = {
      files: [{ name: "schemas/public.sql", sql: "create table public.example(id int);" }],
      manifest: { redactSecrets: true, scope: "database", profile: "supabase" },
    };

    return write(declDir, output).pipe(
      Effect.flatMap(() =>
        Effect.sync(() => {
          const old = new Date("2020-01-01T00:00:00.000Z");
          utimesSync(schemaPath, old, old);
          utimesSync(manifestPath, old, old);
        }),
      ),
      Effect.flatMap(() => write(declDir, output)),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(statSync(schemaPath).mtime.toISOString()).toBe("2020-01-01T00:00:00.000Z");
          expect(statSync(manifestPath).mtime.toISOString()).toBe("2020-01-01T00:00:00.000Z");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("rejects next-engine output targeting the reserved custom directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-write-"));
    const declDir = join(dir, "supabase", "database");
    return write(declDir, {
      files: [{ name: "_custom/generated.sql", sql: "select 1;" }],
      manifest: { redactSecrets: true, scope: "database" },
    }).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
            expect(error).toBeInstanceOf(LegacyDeclarativeWriteError);
            expect((error as LegacyDeclarativeWriteError).message).toBe(
              "refusing to write into reserved declarative schema path: _custom/generated.sql",
            );
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("creates the declarative dir when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-write-"));
    const declDir = join(dir, "supabase", "database");
    return write(declDir, {
      version: 1,
      mode: "declarative",
      files: [{ path: "public.sql", order: 0, statements: 0, sql: "select 1;" }],
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(readFileSync(join(declDir, "public.sql"), "utf8")).toBe("select 1;");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("rejects an unsafe (path-escaping) export path", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-write-"));
    const declDir = join(dir, "supabase", "database");
    return write(declDir, {
      version: 1,
      mode: "declarative",
      files: [{ path: "../escape.sql", order: 0, statements: 0, sql: "x" }],
    }).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
            expect(error).toBeInstanceOf(LegacyDeclarativeWriteError);
            expect((error as LegacyDeclarativeWriteError).message).toBe(
              "unsafe declarative export path: ../escape.sql",
            );
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});

describe("legacyDeclarativeSchemaWrittenLine", () => {
  it("formats the shared written-to line for the given dir", () => {
    expect(legacyDeclarativeSchemaWrittenLine("supabase/database")).toBe(
      `Declarative schema written to ${legacyBold("supabase/database")}\n`,
    );
  });
});
