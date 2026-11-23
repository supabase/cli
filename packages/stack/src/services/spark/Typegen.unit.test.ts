import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { Description } from "./Description.ts";
import { typescript } from "./Typegen.ts";

const column = (name: string, position: number, type: string, identity: "a" | null) => ({
  name,
  position,
  type,
  not_null: true,
  default: null,
  identity,
  generated: null,
  comment: null,
});

// `GET /_spark/v1/schema` as Spark sends it: a table and a view over it with its own columns.
const wire = JSON.stringify({
  schema_version: "1",
  managed_schemas: ["auth"],
  schemas: [{ name: "public", comment: null }],
  enums: [],
  tables: [
    {
      schema: "public",
      name: "authors",
      managed: false,
      rls_enabled: true,
      rls_forced: false,
      comment: null,
      columns: [column("id", 1, "bigint", "a"), column("name", 2, "text", null)],
      constraints: [],
      indexes: [],
      policies: [],
    },
  ],
  views: [
    {
      schema: "public",
      name: "author_names",
      def: "select name from public.authors",
      depends_on: [{ schema: "public", name: "authors" }],
      comment: null,
      columns: [column("name", 1, "text", null)],
    },
  ],
});

describe("typescript", () => {
  it.effect("renders the tables and views of a description decoded from Spark's JSON", () =>
    Effect.gen(function* () {
      const description = yield* Schema.decodeEffect(Schema.fromJsonString(Description))(wire);

      const types = (yield* typescript(description, ["public"])).replace(/\s+/gu, " ");

      expect(types).toContain('Insert: { "id"?: never,"name": string }');
      expect(types).toContain('Views: { "author_names": { Row: { "name": string }');
    }),
  );
});
