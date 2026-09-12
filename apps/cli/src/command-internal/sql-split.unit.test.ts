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

  it.each(["a²", "a😀", "á"])("respects non-ASCII dollar tag $%s$", (tag) => {
    const statement = `CREATE FUNCTION f() AS $${tag}$foo; END; bar$${tag}$ LANGUAGE sql`;
    expect(splitAndTrim(`${statement}; SELECT 2;`)).toEqual([statement, "SELECT 2"]);
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

  it.each([
    "pending",
    "pending_change",
    "append",
    "legend",
    "𐐀end",
    "😀end",
    "́end",
    "²end",
    "pending$$foo$",
  ])("does not close a BEGIN ATOMIC body inside %s", (identifier) => {
    const body = `CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1 AS ${identifier}; END`;
    expect(splitAndTrim(`${body}; SELECT 2;`)).toEqual([body, "SELECT 2"]);
  });

  it.each(["endpoint", "end_date", "ended_at", "end𐐀", "end😀", "end́", "end²", "end$$foo$"])(
    "does not close a BEGIN ATOMIC body at the start of %s",
    (identifier) => {
      const body = `CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT ${identifier}; SELECT 1; END`;
      expect(splitAndTrim(`${body}; SELECT 2;`)).toEqual([body, "SELECT 2"]);
    },
  );
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
