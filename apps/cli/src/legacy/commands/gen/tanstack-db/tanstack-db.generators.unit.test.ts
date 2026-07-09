import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import {
  legacyDecodeOpenApiDefinitions,
  legacyGenerateTanstackDbFile,
  legacyMergeOpenApiDefinitions,
} from "./tanstack-db.generators.ts";

function todosDefinition() {
  return {
    todos: {
      properties: {
        id: { type: "integer", description: "Note:\nThis is a Primary Key.<pk/>" },
        title: { type: "string" },
        status: { type: "string", enum: ["open", "closed"] },
        created_at: { type: "string", format: "timestamp with time zone" },
        tags: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
      },
      required: ["id", "title"],
    },
  };
}

describe("legacyGenerateTanstackDbFile", () => {
  it.effect("generates a Zod schema and TanStack DB collection per table", () =>
    Effect.gen(function* () {
      const content = yield* legacyGenerateTanstackDbFile(todosDefinition());

      expect(content).toContain("export const todosSchema = z.object({");
      expect(content).toContain('"id": z.number().int(),');
      expect(content).toContain('"title": z.string(),');
      expect(content).toContain("\"status\": z.enum(['open', 'closed']).nullable(),");
      expect(content).toContain('"created_at": z.string().nullable(),');
      expect(content).toContain('"tags": z.array(z.string()).nullable(),');
      expect(content).toContain('"metadata": z.record(z.unknown()).nullable(),');
      expect(content).toContain("export type Todos = z.infer<typeof todosSchema>");

      expect(content).toContain(
        "export const todosCollection = createCollection(supabaseCollectionOptions({",
      );
      expect(content).toContain('tableName: "todos",');
      expect(content).toContain("schema: todosSchema,");
      expect(content).toContain('keys: ["id"],');
    }),
  );

  it.effect("skips tables whose name starts with an underscore", () =>
    Effect.gen(function* () {
      const content = yield* legacyGenerateTanstackDbFile({
        ...todosDefinition(),
        _internal: { properties: {} },
      });
      expect(content).not.toContain("_internal");
    }),
  );

  it.effect("falls back to a literal 'id' column when no primary-key hint is present", () =>
    Effect.gen(function* () {
      const content = yield* legacyGenerateTanstackDbFile({
        widgets: {
          properties: { id: { type: "string" }, name: { type: "string" } },
          required: ["id"],
        },
      });
      expect(content).toContain('keys: ["id"],');
    }),
  );

  it.effect("composes a composite key from multiple primary-key columns", () =>
    Effect.gen(function* () {
      const content = yield* legacyGenerateTanstackDbFile({
        memberships: {
          properties: {
            org_id: { type: "string", description: "Note:\nThis is a Primary Key.<pk/>" },
            user_id: { type: "string", description: "Note:\nThis is a Primary Key.<pk/>" },
          },
          required: ["org_id", "user_id"],
        },
      });
      expect(content).toContain('keys: ["org_id", "user_id"],');
    }),
  );

  it.effect("keeps a primary key column name verbatim even when it isn't a valid identifier", () =>
    Effect.gen(function* () {
      const content = yield* legacyGenerateTanstackDbFile({
        todos: {
          properties: {
            "not-an-id": {
              type: "string",
              description: "Note:\nThis is a Primary Key.<pk/>",
            },
          },
          required: [],
        },
      });
      expect(content).toContain('keys: ["not-an-id"],');
    }),
  );

  it.effect("fails with a typed error when a table has no primary key", () =>
    Effect.gen(function* () {
      const exit = yield* legacyGenerateTanstackDbFile({
        orphans: { properties: { name: { type: "string" } }, required: [] },
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("has no primary key columns");
      }
    }),
  );

  it.effect("fails with a typed error when no tables are found", () =>
    Effect.gen(function* () {
      const exit = yield* legacyGenerateTanstackDbFile({ _internal: { properties: {} } }).pipe(
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("no tables found");
      }
    }),
  );
});

describe("legacyMergeOpenApiDefinitions", () => {
  it("merges multiple schema documents, later documents winning on a name collision", () => {
    const merged = legacyMergeOpenApiDefinitions([
      { todos: { properties: { id: { type: "string" } } } },
      { accounts: { properties: { id: { type: "string" } } } },
      { todos: { properties: { id: { type: "string" }, extra: { type: "string" } } } },
    ]);

    expect(Object.keys(merged)).toEqual(["todos", "accounts"]);
    expect(merged["todos"]?.properties).toHaveProperty("extra");
  });
});

describe("legacyDecodeOpenApiDefinitions", () => {
  it.effect("decodes definitions from a raw OpenAPI document", () =>
    Effect.gen(function* () {
      const result = yield* legacyDecodeOpenApiDefinitions({
        swagger: "2.0",
        definitions: { todos: { properties: {} } },
      });
      expect(result).toEqual({ todos: { properties: {} } });
    }),
  );

  it.effect("defaults to an empty map when definitions is missing", () =>
    Effect.gen(function* () {
      const result = yield* legacyDecodeOpenApiDefinitions({ swagger: "2.0" });
      expect(result).toEqual({});
    }),
  );

  it.effect("fails with a typed decode error for a malformed document", () =>
    Effect.gen(function* () {
      const exit = yield* legacyDecodeOpenApiDefinitions({ definitions: "not-an-object" }).pipe(
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("failed to decode database schema");
      }
    }),
  );
});
