import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { renderSchemaResult } from "./schema-render.ts";
import type { SchemaCommandResult } from "./schema-types.ts";

function result(overrides: Partial<SchemaCommandResult> = {}): SchemaCommandResult {
  return {
    status: "clean",
    message: "4 migrations applied on the local database. History matches files.",
    data: {},
    nextActions: [],
    mutatedDatabase: false,
    mutatedFiles: false,
    ...overrides,
  };
}

describe("renderSchemaResult", () => {
  it.live("prints a single next action on one line", () => {
    const out = mockOutput();
    return Effect.gen(function* () {
      yield* renderSchemaResult(
        "Create migration",
        result({
          nextActions: ["to apply it locally: supabase migrations apply"],
        }),
      ).pipe(Effect.provide(out.layer));
      expect(out.messages).toEqual([
        { type: "intro", message: "Create migration" },
        {
          type: "info",
          message: "Next: to apply it locally: supabase migrations apply",
        },
        {
          type: "outro",
          message: "4 migrations applied on the local database. History matches files.",
        },
      ]);
    });
  });

  it.live("skipIntro does not emit a second intro", () => {
    const out = mockOutput();
    return Effect.gen(function* () {
      yield* renderSchemaResult("Push migrations", result(), { skipIntro: true }).pipe(
        Effect.provide(out.layer),
      );
      expect(out.messages).toEqual([
        {
          type: "outro",
          message: "4 migrations applied on the local database. History matches files.",
        },
      ]);
    });
  });

  it.live("prints a single-line success once as the outro", () => {
    const out = mockOutput();
    return Effect.gen(function* () {
      yield* renderSchemaResult("List migrations", result()).pipe(Effect.provide(out.layer));
      expect(out.messages).toEqual([
        { type: "intro", message: "List migrations" },
        {
          type: "outro",
          message: "4 migrations applied on the local database. History matches files.",
        },
      ]);
    });
  });

  it.live("outros the status line and lists extra lines above it", () => {
    const out = mockOutput();
    return Effect.gen(function* () {
      yield* renderSchemaResult(
        "Generate schema migrations",
        result({
          message:
            "Declarations already match migration replay.\n1 unmodeled cast (log_min_messages)",
          nextActions: [
            "to check they match: supabase schema generate --dry-run",
            "to generate a migration: supabase schema generate --name <feature>",
          ],
        }),
      ).pipe(Effect.provide(out.layer));
      expect(out.messages).toEqual([
        { type: "intro", message: "Generate schema migrations" },
        { type: "info", message: "1 unmodeled cast (log_min_messages)" },
        { type: "info", message: "Next:" },
        {
          type: "info",
          message: "  1. to check they match: supabase schema generate --dry-run",
        },
        {
          type: "info",
          message: "  2. to generate a migration: supabase schema generate --name <feature>",
        },
        { type: "outro", message: "Declarations already match migration replay." },
      ]);
    });
  });

  it.live("writes body as one raw chunk and keeps extra message lines as info", () => {
    const out = mockOutput();
    const sql = "CREATE TABLE t (id int);\nALTER TABLE t ADD COLUMN n int;";
    return Effect.gen(function* () {
      yield* renderSchemaResult(
        "Generate schema migrations",
        result({
          message: "Dry-run; nothing was written.\n2 statements",
          body: sql,
          nextActions: ["to write the migration: supabase schema generate --name <feature>"],
        }),
      ).pipe(Effect.provide(out.layer));
      expect(out.messages).toEqual([
        { type: "intro", message: "Generate schema migrations" },
        { type: "info", message: "2 statements" },
        {
          type: "info",
          message: "Next: to write the migration: supabase schema generate --name <feature>",
        },
        { type: "outro", message: "Dry-run; nothing was written." },
      ]);
      expect(out.rawChunks).toEqual([{ text: `${sql}\n`, stream: "stdout" }]);
    });
  });

  it.live("emits JSON from message and data without dumping body", () => {
    const out = mockOutput({ format: "json" });
    const sql = "CREATE TABLE t (id int);";
    return Effect.gen(function* () {
      yield* renderSchemaResult(
        "Generate schema migrations",
        result({
          message: "2 statements",
          body: sql,
          data: { sql, files: [{ name: "schema.sql", sql }] },
        }),
      ).pipe(Effect.provide(out.layer));
      expect(out.messages).toEqual([
        { type: "intro", message: "Generate schema migrations" },
        {
          type: "success",
          message: "2 statements",
          data: { sql, files: [{ name: "schema.sql", sql }] },
        },
      ]);
      expect(out.rawChunks).toEqual([]);
    });
  });
});
