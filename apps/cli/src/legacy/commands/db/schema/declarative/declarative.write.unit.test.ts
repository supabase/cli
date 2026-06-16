import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Path } from "effect";

import { LegacyDeclarativeWriteError } from "./declarative.errors.ts";
import type { LegacyDeclarativeOutput } from "./declarative.pgdelta.ts";
import { legacyFindDropStatements, legacyWriteDeclarativeSchemas } from "./declarative.write.ts";

describe("legacyFindDropStatements", () => {
  it("flags DROP statements (case-insensitive) and ignores others", () => {
    const sql = "DROP TABLE a;\nCREATE TABLE b();\ndrop function f();";
    expect(legacyFindDropStatements(sql)).toEqual(["DROP TABLE a", "drop function f()"]);
  });

  it("does not split a function body on its inner ; (no spurious statements)", () => {
    // The dollar-quoted `;` must not create extra statements; this benign
    // function (no DROP) stays whole and is therefore not flagged.
    const sql =
      "CREATE FUNCTION f() AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;\nDROP TABLE real;";
    expect(legacyFindDropStatements(sql)).toEqual(["DROP TABLE real"]);
  });
});

const write = (declarativeDir: string, output: LegacyDeclarativeOutput) =>
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
