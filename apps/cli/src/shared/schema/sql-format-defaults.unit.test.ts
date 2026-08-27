import { describe, expect, it } from "vitest";
import { formatSchemaSql, SCHEMA_SQL_FORMAT_DEFAULTS } from "./sql-format-defaults.ts";

describe("formatSchemaSql", () => {
  it("pretty-prints with the CLI default options", () => {
    expect(
      formatSchemaSql(
        "create table public.widgets (id integer, display_name text);",
        SCHEMA_SQL_FORMAT_DEFAULTS,
      ),
    ).toBe(`CREATE TABLE public.widgets (
  id           integer,
  display_name text
);
`);
  });
});
