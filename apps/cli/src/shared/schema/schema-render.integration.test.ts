import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { renderSchemaResult } from "./schema-render.ts";
import type { SchemaCommandResult } from "./schema-types.ts";

function result(overrides: Partial<SchemaCommandResult> = {}): SchemaCommandResult {
  return {
    status: "clean",
    message: "Compared 4 migration(s) against local:default.",
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
        { type: "outro", message: "Compared 4 migration(s) against local:default." },
      ]);
    });
  });

  it.live("prints a single-line success once as the outro", () => {
    const out = mockOutput();
    return Effect.gen(function* () {
      yield* renderSchemaResult("List migrations", result()).pipe(Effect.provide(out.layer));
      expect(out.messages).toEqual([
        { type: "intro", message: "List migrations" },
        { type: "outro", message: "Compared 4 migration(s) against local:default." },
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
});
