import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeModel } from "./Catalog.ts";
import type { Column, Constraint, Description, Table } from "./Description.ts";
import { typescript } from "./Typegen.ts";

const column = (name: string, position: number, type: string, extra: Partial<Column> = {}) => ({
  name,
  position,
  type,
  not_null: false,
  default: null,
  identity: null,
  generated: null,
  comment: null,
  ...extra,
});

const table = (
  name: string,
  columns: ReadonlyArray<Column>,
  constraints: ReadonlyArray<Constraint>,
): Table => ({
  schema: "public",
  name,
  managed: false,
  rls_enabled: true,
  rls_forced: false,
  comment: null,
  columns,
  constraints,
  indexes: [],
  policies: [],
});

const primaryKey = (name: string, col: string): Constraint => ({
  name,
  type: "p",
  def: `PRIMARY KEY (${col})`,
  columns: [col],
  references: null,
});

const foreignKey = (name: string, col: string): Constraint => ({
  name,
  type: "f",
  def: `FOREIGN KEY (${col}) REFERENCES authors(id)`,
  columns: [col],
  references: { schema: "public", table: "authors", columns: ["id"] },
});

const description: Description = {
  schema_version: "1",
  managed_schemas: ["auth"],
  schemas: [{ name: "public", comment: null }],
  enums: [{ schema: "public", name: "status", labels: ["open", "done"], comment: null }],
  tables: [
    table(
      "authors",
      [column("id", 1, "bigint", { not_null: true, identity: "a" }), column("name", 2, "text")],
      [primaryKey("authors_pkey", "id")],
    ),
    table(
      "profiles",
      [column("author_id", 1, "bigint", { not_null: true })],
      [
        primaryKey("profiles_pkey", "author_id"),
        foreignKey("profiles_author_id_fkey", "author_id"),
      ],
    ),
    table(
      "posts",
      [
        column("author_id", 1, "bigint", { not_null: true }),
        column("status", 2, "status", { not_null: true, default: "'open'::status" }),
        column("tags", 3, "text[]"),
        column("matrix", 4, "integer[][]"),
      ],
      [foreignKey("posts_author_id_fkey", "author_id")],
    ),
  ],
  views: [],
};

const squash = (s: string) => s.replace(/\s+/gu, " ");

describe("typescript", () => {
  it.effect("renders Spark's description through the shared generator", () =>
    Effect.gen(function* () {
      const types = squash(yield* typescript(makeModel(description), ["public"]));

      expect(types).toContain('Insert: { "id"?: never,"name"?: string | null }');
      expect(types).toContain(
        'Row: { "author_id": number,"matrix": (number)[] | null,"status": Database["public"][\'Enums\']["status"],"tags": (string)[] | null }',
      );
      expect(types).toContain(
        'foreignKeyName: "profiles_author_id_fkey" columns: ["author_id"] isOneToOne: true',
      );
      expect(types).toContain(
        'foreignKeyName: "posts_author_id_fkey" columns: ["author_id"] isOneToOne: false',
      );
      expect(types).toContain('"status": "open"|"done"');
      expect(types).toContain("export const Constants");
    }),
  );
});
