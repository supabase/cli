import { describe, expect, it } from "vitest";

import { findDropStatements, splitAndTrim, splitSql } from "./sql-split.ts";

describe("splitAndTrim", () => {
  it("splits simple statements and trims trailing ; + whitespace", () => {
    expect(splitAndTrim("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("drops empty trailing statements", () => {
    expect(splitAndTrim("SELECT 1;\n\n")).toEqual(["SELECT 1"]);
  });

  it("keeps a non-terminated final statement", () => {
    expect(splitAndTrim("SELECT 1")).toEqual(["SELECT 1"]);
  });

  it("does not split on a ; inside a single-quoted literal", () => {
    expect(splitAndTrim("SELECT ';'; SELECT 2")).toEqual(["SELECT ';'", "SELECT 2"]);
  });

  it("handles doubled single quotes inside a literal", () => {
    expect(splitAndTrim("SELECT 'a''; b'; SELECT 2")).toEqual(["SELECT 'a''; b'", "SELECT 2"]);
  });

  it("does not split on a ; inside a dollar-quoted function body", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 2;";
    expect(splitAndTrim(sql)).toEqual([
      "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql",
      "SELECT 2",
    ]);
  });

  it("treats a non-decimal Unicode digit as an invalid dollar-tag character, like Go's unicode.IsDigit", () => {
    // "a²" (U+00B2, category No) is not a valid dollar-tag character, so the tag falls back
    // and the embedded `;` becomes a real boundary.
    const sql = "CREATE FUNCTION f() AS $a²$foo; bar$a²$ LANGUAGE sql;";
    expect(splitAndTrim(sql)).toEqual(["CREATE FUNCTION f() AS $a²$foo", "bar$a²$ LANGUAGE sql"]);
  });

  it("respects named dollar tags", () => {
    const sql = "CREATE FUNCTION f() AS $body$ SELECT ';'; $body$ LANGUAGE sql; SELECT 2;";
    expect(splitAndTrim(sql)).toEqual([
      "CREATE FUNCTION f() AS $body$ SELECT ';'; $body$ LANGUAGE sql",
      "SELECT 2",
    ]);
  });

  it("ignores a ; inside a line comment", () => {
    expect(splitAndTrim("SELECT 1 -- a; b\n; SELECT 2")).toEqual(["SELECT 1 -- a; b", "SELECT 2"]);
  });

  it("ignores a ; inside a block comment (nested)", () => {
    expect(splitAndTrim("SELECT 1 /* a; /* n; */ b; */; SELECT 2")).toEqual([
      "SELECT 1 /* a; /* n; */ b; */",
      "SELECT 2",
    ]);
  });

  it("does not split inside a BEGIN ATOMIC body", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END; SELECT 3;";
    expect(splitAndTrim(sql)).toEqual([
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END",
      "SELECT 3",
    ]);
  });
});

describe("BEGIN ATOMIC bodies", () => {
  const body = (statement: string): string =>
    `create or replace function public.probe_splitter() returns integer
language sql
immutable
begin atomic
  ${statement};
end`;
  const split = (statement: string): string[] =>
    splitAndTrim(`${body(statement)};\nselect 2;`);

  it("keeps a ; inside the body together with the statement", () => {
    expect(split("select 1")).toEqual([body("select 1"), "select 2"]);
  });

  it.each(["pending", "pending_change", "append", "legend", "END_"])(
    "does not close the body at an identifier ending in end: %s",
    (name) => {
      expect(split(`select 1 as ${name}`)).toEqual([body(`select 1 as ${name}`), "select 2"]);
    },
  );

  it.each(["endpoint", "end_date", "ended_at", "endx"])(
    "does not close the body at an identifier starting with end: %s",
    (name) => {
      const statement = `select ${name} from public.t;\n  select 1`;
      expect(split(statement)).toEqual([body(statement), "select 2"]);
    },
  );

  it("closes on end followed by a newline or a comment", () => {
    const sql = "begin atomic\n  select 1;\nend\n;\nbegin atomic select 1; end -- done\n;";
    expect(splitAndTrim(sql)).toEqual([
      "begin atomic\n  select 1;\nend",
      "begin atomic select 1; end -- done",
    ]);
  });

  it("closes on end at the end of input", () => {
    const sql = "begin atomic; select 'end'; end";
    expect(splitAndTrim(sql)).toEqual([sql]);
  });

  it("still closes a parenthesised group on the closing paren", () => {
    expect(splitAndTrim("select (1; 2); select 3;")).toEqual(["select (1; 2)", "select 3"]);
  });
});

describe("splitSql", () => {
  it("preserves raw statements (no transforms) including the trailing ;-less token", () => {
    expect(splitSql("SELECT 1; SELECT 2")).toEqual(["SELECT 1;", " SELECT 2"]);
  });
});

describe("findDropStatements", () => {
  it("flags DROP statements (case-insensitive) and ignores others", () => {
    const sql = "DROP TABLE a;\nCREATE TABLE b();\ndrop function f();";
    expect(findDropStatements(sql)).toEqual(["DROP TABLE a", "drop function f()"]);
  });

  it("does not split a function body on its inner ; (no spurious statements)", () => {
    const sql =
      "CREATE FUNCTION f() AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;\nDROP TABLE real;";
    expect(findDropStatements(sql)).toEqual(["DROP TABLE real"]);
  });
});
