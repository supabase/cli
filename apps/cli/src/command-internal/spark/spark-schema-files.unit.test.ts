import { describe, expect, it } from "vitest";

import {
  attributeDryRunStatuses,
  findDeclaration,
  withoutBaselineFiles,
} from "./spark-schema-files.ts";

describe("findDeclaration", () => {
  const files = [
    { name: "public/tables/todos.sql", sql: 'create table "public"."todos" (id int);\n' },
    {
      name: "public/functions.sql",
      sql: '-- helpers\n\nCREATE OR REPLACE FUNCTION "public"."add" (a int, b int) returns int\n  language sql as $$ select 1 $$;\n',
    },
    {
      name: "public/policies.sql",
      sql: 'create policy "Own rows" on public.todos for all using (true);\ngrant usage on schema public to anon;\ncreate extension if not exists pgcrypto;\n',
    },
  ];

  it.each([
    ["CREATE OR REPLACE FUNCTION public.add (a integer, b integer)", "public/functions.sql", 3],
    ["create function add(a int)", "public/functions.sql", 3],
    ['CREATE POLICY "Own rows" ON "public"."todos"', "public/policies.sql", 1],
    ["GRANT USAGE ON SCHEMA public TO anon", "public/policies.sql", 2],
    ['CREATE EXTENSION "pgcrypto" SCHEMA "extensions"', "public/policies.sql", 3],
  ])("finds %s", (statement, file, line) => {
    expect(findDeclaration(statement, files)).toEqual({ file, line });
  });

  it("finds nothing for an object the files do not declare", () => {
    expect(findDeclaration("create function other.add()", files)).toBeUndefined();
    expect(findDeclaration("create table public.t (id int)", files)).toBeUndefined();
  });
});

describe("withoutBaselineFiles", () => {
  it("drops files identical in the baseline from the files and the manifest", () => {
    const exported = {
      files: [
        { name: "a.sql", sql: "same" },
        { name: "b.sql", sql: "changed" },
        { name: "c.sql", sql: "new" },
      ],
      manifest: { files: ["a.sql", "b.sql", "c.sql"], loadOrder: ["a.sql", "c.sql", "b.sql"] },
    };
    const baseline = {
      files: [
        { name: "a.sql", sql: "same" },
        { name: "b.sql", sql: "base" },
      ],
      manifest: {},
    };

    expect(withoutBaselineFiles(exported, baseline)).toEqual({
      files: [
        { name: "b.sql", sql: "changed" },
        { name: "c.sql", sql: "new" },
      ],
      manifest: { files: ["b.sql", "c.sql"], loadOrder: ["c.sql", "b.sql"] },
    });
  });
});

describe("attributeDryRunStatuses", () => {
  const status = (index: number, st: string, statement: string) => ({
    index,
    status: st,
    statement,
    message: null as string | null,
  });

  it("keeps identical refused statements in different files apart", () => {
    const files = [
      { file: "1_a.sql", query: "create function f() returns int;\n" },
      { file: "2_b.sql", query: "create function f() returns int;\n" },
    ];
    const { refused, silent } = attributeDryRunStatuses(
      [
        status(0, "unsupported", "create function f() returns int"),
        status(1, "unsupported", "create function f() returns int"),
      ],
      files,
    );
    expect(refused.map((r) => r.file)).toEqual(["1_a.sql", "2_b.sql"]);
    expect(silent).toEqual([]);
  });

  it("refuses a fold into a table another earlier file creates, not one in the same file", () => {
    const fold = "ALTER TABLE public.t ADD CONSTRAINT c CHECK (id > 0)";
    const files = [
      { file: "1_a.sql", query: "create table public.t (id int);\n" },
      { file: "2_b.sql", query: `${fold};\n` },
    ];
    const { refused } = attributeDryRunStatuses(
      [status(0, "ok", "create table public.t (id int)"), status(1, "rewritten", fold)],
      files,
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.file).toBe("2_b.sql");
    expect(refused[0]?.status.message).toContain("folds into a table created in 1_a.sql");

    const same = attributeDryRunStatuses(
      [status(0, "ok", "create table public.t (id int)"), status(1, "rewritten", fold)],
      [{ file: "1_a.sql", query: `create table public.t (id int);\n${fold};\n` }],
    );
    expect(same.refused).toEqual([]);
  });

  it("lists a file that received no status", () => {
    const files = [
      { file: "1_a.sql", query: "create table t (id int);\n" },
      { file: "2_b.sql", query: "-- nothing\n" },
    ];
    const { refused, silent } = attributeDryRunStatuses(
      [status(0, "ok", "create table t (id int)")],
      files,
    );
    expect(refused).toEqual([]);
    expect(silent).toEqual(["2_b.sql"]);
  });
});
