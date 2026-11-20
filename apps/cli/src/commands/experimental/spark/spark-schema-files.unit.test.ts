import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  attributeDryRunStatuses,
  locateInSchemaFiles,
  withoutBaselineFiles,
} from "./spark-schema-files.ts";

describe("locateInSchemaFiles", () => {
  const files = [
    {
      name: "public/tables/events.sql",
      sql: '-- events\r\n\r\nCREATE TABLE "public"."events" (\r\n  "id" bigint NOT NULL,\r\n  /* legacy */ "day" date\r\n);\r\n\r\nCREATE INDEX events_day_idx ON public.events (day);\r\nALTER TABLE public.events ALTER COLUMN day TYPE date;\r\n',
    },
    {
      name: "public/functions.sql",
      sql: '-- helpers\n\nCREATE OR REPLACE FUNCTION "public"."add" (a int, b int) returns int\n  language sql as $$ select 1 $$;\n',
    },
    {
      name: "public/views.sql",
      sql: "create view public.recent as select 1 as id;\nalter table public.links add constraint links_note_fkey foreign key (id) references public.notes (id);\nalter table public.notes add column title text;\n",
    },
    {
      name: "public/policies.sql",
      sql: 'create policy "Own rows" on public.events for all using (true);\ngrant usage on schema public to anon;\ncreate extension if not exists pgcrypto;\n',
    },
  ];
  const at = (file: string, line: number) => ({ file, line });

  it.effect("locates each refused statement by the object it creates or acts on", () =>
    Effect.gen(function* () {
      expect(
        yield* locateInSchemaFiles(
          [
            'CREATE TABLE "public"."events" ( "id" bigint NOT NULL, "day" date, CONSTRAINT "events_pkey" PRIMARY KEY (id) )',
            'GRANT DELETE, INSERT ON TABLE "public"."events" TO "anon", "authenticated"',
            'REVOKE ALL ON TABLE "public"."events" FROM "postgres"',
            "CREATE INDEX events_day_idx ON public.events USING btree (day)",
            "CREATE UNIQUE INDEX other_idx ON public.events (id)",
            "ALTER TABLE public.events ALTER COLUMN day TYPE date",
            "CREATE OR REPLACE FUNCTION public.add(a integer, b integer) RETURNS integer LANGUAGE sql AS $function$ select 1 $function$",
            'CREATE POLICY "Own rows" ON "public"."events" FOR ALL USING (true)',
            "GRANT USAGE ON SCHEMA public TO anon",
            'CREATE EXTENSION IF NOT EXISTS "pgcrypto"',
            "CREATE TABLE public.other (id int)",
            'GRANT SELECT ON TABLE "public"."recent" TO "anon"',
            "ALTER TABLE public.notes ADD COLUMN body text",
          ],
          files,
        ),
      ).toEqual([
        at("public/tables/events.sql", 3),
        at("public/tables/events.sql", 3),
        at("public/tables/events.sql", 3),
        at("public/tables/events.sql", 8),
        at("public/tables/events.sql", 3),
        at("public/tables/events.sql", 9),
        at("public/functions.sql", 3),
        at("public/policies.sql", 1),
        at("public/policies.sql", 2),
        at("public/policies.sql", 3),
        undefined,
        at("public/views.sql", 1),
        at("public/views.sql", 3),
      ]);
    }),
  );
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

  it.effect("keeps identical refused statements in different files apart", () =>
    Effect.gen(function* () {
      const files = [
        { file: "1_a.sql", query: "create function f() returns int;\n" },
        { file: "2_b.sql", query: "create function f() returns int;\n" },
      ];
      const { refused, silent } = yield* attributeDryRunStatuses(
        [
          status(0, "unsupported", "create function f() returns int"),
          status(1, "unsupported", "create function f() returns int"),
        ],
        files,
      );
      expect(refused.map((r) => [r.file, r.line])).toEqual([
        ["1_a.sql", 1],
        ["2_b.sql", 1],
      ]);
      expect(silent).toEqual([]);
    }),
  );

  it.effect("gives each refused statement its own line, past comments, in CRLF files too", () =>
    Effect.gen(function* () {
      const files = [
        { file: "1_a.sql", query: "create table t (id int);\n" },
        {
          file: "2_b.sql",
          query:
            "-- events\r\n\r\ncreate table e (\r\n  id int,\r\n  day date\r\n);\r\ncreate   index i on e (day);\r\n",
        },
      ];
      const { refused } = yield* attributeDryRunStatuses(
        [
          status(0, "ok", "create table t (id int)"),
          status(1, "unsupported", "-- events create table e ( id int, day date )"),
          status(2, "error", "create index i on e (day)"),
        ],
        files,
      );
      expect(refused.map((r) => [r.file, r.line])).toEqual([
        ["2_b.sql", 3],
        ["2_b.sql", 7],
      ]);
    }),
  );

  it.effect(
    "locates a refused CREATE TABLE that Spark merged with a later ALTER TABLE ... ADD",
    () =>
      Effect.gen(function* () {
        const files = [
          {
            file: "1_a.sql",
            query:
              "create table public.b1 (id int primary key);\nalter table public.b1 add column day date;\n",
          },
        ];
        const { refused, silent } = yield* attributeDryRunStatuses(
          [status(0, "unsupported", "create table public.b1 (id int primary key, day date)")],
          files,
        );
        expect(refused.map((r) => [r.file, r.line])).toEqual([["1_a.sql", 1]]);
        expect(silent).toEqual([]);
      }),
  );

  it.effect(
    "refuses a fold into a table another earlier file creates, not one in the same file",
    () =>
      Effect.gen(function* () {
        const fold = "ALTER TABLE public.t ADD CONSTRAINT c CHECK (id > 0)";
        const files = [
          { file: "1_a.sql", query: "create table public.t (id int);\n" },
          { file: "2_b.sql", query: `${fold};\n` },
        ];
        const { refused } = yield* attributeDryRunStatuses(
          [status(0, "ok", "create table public.t (id int)"), status(1, "rewritten", fold)],
          files,
        );
        expect(refused).toHaveLength(1);
        expect(refused[0]?.file).toBe("2_b.sql");
        expect(refused[0]?.status.message).toContain("folds into a table created in 1_a.sql");

        const same = yield* attributeDryRunStatuses(
          [status(0, "ok", "create table public.t (id int)"), status(1, "rewritten", fold)],
          [{ file: "1_a.sql", query: `create table public.t (id int);\n${fold};\n` }],
        );
        expect(same.refused).toEqual([]);
      }),
  );

  it.effect("matches a status whose text Spark's local API cut at 200 characters", () =>
    Effect.gen(function* () {
      const columns = Array.from({ length: 30 }, (_, i) => `col_${i} text`).join(", ");
      const statement = `create table public.wide (id int primary key, ${columns})`;
      const { refused, silent } = yield* attributeDryRunStatuses(
        [status(0, "unsupported", `-- wide ${statement}`.slice(0, 200))],
        [{ file: "1_a.sql", query: `-- wide\n${statement};\n` }],
      );
      expect(refused.map((r) => [r.file, r.line])).toEqual([["1_a.sql", 2]]);
      expect(silent).toEqual([]);
    }),
  );

  it.effect("folds into the latest CREATE TABLE, after a drop and re-create", () =>
    Effect.gen(function* () {
      const fold = "ALTER TABLE public.t ADD COLUMN note text";
      const { refused } = yield* attributeDryRunStatuses(
        [
          status(0, "ok", "create table public.t (id int)"),
          status(1, "ok", "drop table public.t"),
          status(2, "ok", "create table public.t (id bigint)"),
          status(3, "rewritten", fold),
        ],
        [
          { file: "1_a.sql", query: "create table public.t (id int);\n" },
          {
            file: "2_b.sql",
            query: `drop table public.t;\ncreate table public.t (id bigint);\n${fold};\n`,
          },
        ],
      );
      expect(refused).toEqual([]);
    }),
  );

  it.effect("does not call a file it cannot parse silent", () =>
    Effect.gen(function* () {
      const { silent } = yield* attributeDryRunStatuses(
        [status(0, "error", "creat tabel x")],
        [{ file: "1_a.sql", query: "creat tabel x;\n" }],
      );
      expect(silent).toEqual([]);
    }),
  );

  it.effect("lists a file that received no status", () =>
    Effect.gen(function* () {
      const files = [
        { file: "1_a.sql", query: "create table t (id int);\n" },
        { file: "2_b.sql", query: "-- nothing\n" },
      ];
      const { refused, silent } = yield* attributeDryRunStatuses(
        [status(0, "ok", "create table t (id int)")],
        files,
      );
      expect(refused).toEqual([]);
      expect(silent).toEqual(["2_b.sql"]);
    }),
  );
});
