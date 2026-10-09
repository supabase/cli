import { describe, expect, it } from "vitest";

import { findDropStatements, splitAndTrim, splitSql, splitSqlTokens } from "./sql-split.ts";

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

  it.each([
    String.raw`SELECT E'it\'s; here'`,
    String.raw`SELECT e'it\'s; here'`,
    String.raw`E'it\'s; here'`,
    String.raw`SELECT (E'a\'; b'),E'c\'; d',1=E'e\'; f'`,
    String.raw`SELECT E'a\\\'; b'`,
    String.raw`SELECT E'a''\'; b'`,
    String.raw`SELECT 'a'E'b\'; c'`,
    String.raw`CREATE FUNCTION f() BEGIN ATOMIC SELECT E'a\'; END; b'; END`,
    String.raw`SELECT $$a$$ /* b */E'c\'; d'`,
  ])("keeps a backslash-escaped quote inside an escape string: %s", (statement) => {
    expect(splitAndTrim(`${statement}; SELECT 2`)).toEqual([statement, "SELECT 2"]);
    expect(splitSqlTokens(`${statement}; SELECT 2`).map((token) => token.trimmed)).toEqual([
      statement,
      "SELECT 2",
    ]);
  });

  it.each([String.raw`SELECT E'a\\'`, String.raw`SELECT E'a''; b'`, String.raw`SELECT E'a\\\\'`])(
    "ends an escape string at its closing quote: %s",
    (statement) => {
      expect(splitAndTrim(`${statement}; SELECT 2`)).toEqual([statement, "SELECT 2"]);
    },
  );

  it("keeps an unterminated escape string ending in a backslash", () => {
    const sql = String.raw`SELECT E'a; b` + "\\";
    expect(splitAndTrim(sql)).toEqual([sql]);
    expect(splitSqlTokens(sql)).toEqual([{ raw: sql, trimmed: sql, terminated: false }]);
  });

  it.each([
    String.raw`SELECT 'a\'`,
    String.raw`SELECT type'a\'`,
    String.raw`SELECT éE'a\'`,
    String.raw`SELECT 😀E'a\'`,
    String.raw`SELECT _e'a\'`,
    String.raw`SELECT U&'a\'`,
    String.raw`SELECT 1 AS E"a\"`,
  ])("keeps the backslash literal outside escape strings: %s", (statement) => {
    expect(splitAndTrim(`${statement}; SELECT 2`)).toEqual([statement, "SELECT 2"]);
  });

  it.each([
    "SELECT E'first'\n'second\\'; third'",
    "SELECT E'first'\r\n'second\\'; third'",
    "SELECT E'first'\r'second\\'; third'",
    "SELECT E'first' \t\v\f\n\n \v'second\\'; third'",
    "SELECT E'a'\n'b'\n'c\\'; d'",
    "SELECT E'a'''\n'b\\'; c'",
    "SELECT E'a' -- note;\n -- more\n'b\\'; c'",
    "SELECT E'a' -- note;\r'b\\'; c'",
    "SELECT (E'a'\n'b\\'; c')",
    "CREATE FUNCTION f() BEGIN ATOMIC SELECT E'a'\n'b\\'; END; c'; END",
  ])("keeps an escape string continued on a later line together: %j", (statement) => {
    expect(splitAndTrim(`${statement}; SELECT 2`)).toEqual([statement, "SELECT 2"]);
    expect(splitSqlTokens(`${statement}; SELECT 2`).map((token) => token.trimmed)).toEqual([
      statement,
      "SELECT 2",
    ]);
  });

  it.each([
    ["SELECT E'a' 'b\\'; SELECT 2", ["SELECT E'a' 'b\\'", "SELECT 2"]],
    ["SELECT E'a'\n/* x */'b\\'; SELECT 2", ["SELECT E'a'\n/* x */'b\\'", "SELECT 2"]],
    ["SELECT E'a'\n-'b\\'; SELECT 2", ["SELECT E'a'\n-'b\\'", "SELECT 2"]],
    ["SELECT E'a'\n- 'b\\'; SELECT 2", ["SELECT E'a'\n- 'b\\'", "SELECT 2"]],
    ["SELECT E'a'\n\"b\\\"; SELECT 2", ["SELECT E'a'\n\"b\\\"", "SELECT 2"]],
    [
      "SELECT E'a' -- c\r|| 'b'\n'c\\'; SELECT 'd', 'e;f'",
      ["SELECT E'a' -- c\r|| 'b'\n'c\\'", "SELECT 'd', 'e;f'"],
    ],
    ["SELECT E'a';\n'b\\'; c'", ["SELECT E'a'", "'b\\'", "c'"]],
    ["SELECT 'a'\n'b\\'; SELECT 2", ["SELECT 'a'\n'b\\'", "SELECT 2"]],
  ])("starts a standard string when it is not a continuation: %j", (sql, statements) => {
    expect(splitAndTrim(sql)).toEqual(statements);
    expect(splitSqlTokens(sql).map((token) => token.trimmed)).toEqual(statements);
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

  it.each(["E'a'", "'a'"])("ends a line comment after %s at a bare carriage return", (literal) => {
    expect(splitAndTrim(`SELECT ${literal} -- a; b\r; SELECT 2`)).toEqual([
      `SELECT ${literal} -- a; b`,
      "SELECT 2",
    ]);
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

  it.each([
    "CASE WHEN true THEN 1 ELSE 0 END",
    "case when true then 1 end",
    "CASE WHEN true THEN 1 END AS ended",
    "CASE WHEN CASE WHEN true THEN true END THEN 1 END",
    "(CASE WHEN (true) THEN 1 END)",
    "coalesce(CASE WHEN length('a') > 0 THEN 1 END, 0)",
    "CASE(1)WHEN 1 THEN 1 END",
    "1 AS case",
    "1 case",
    "1 AS end",
    "1 end",
    "'end'",
  ])("does not close a BEGIN ATOMIC body at an END inside %s", (expression) => {
    const body = `CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT ${expression}; SELECT 1; END`;
    expect(splitAndTrim(`${body}; SELECT 2;`)).toEqual([body, "SELECT 2"]);
  });

  it("does not close a BEGIN ATOMIC body at an END after a carriage-return-ended comment", () => {
    const body =
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; -- c\rSELECT CASE WHEN true THEN 2 END; END";
    expect(splitAndTrim(`${body}; SELECT 3;`)).toEqual([body, "SELECT 3"]);
  });

  it.each(["-- note END\n", "/* note; */ ", "\n/* a /* b; */ */ -- c\n"])(
    "closes a BEGIN ATOMIC body at an END preceded only by comments (%s)",
    (comment) => {
      const body = `CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; ${comment}END`;
      expect(splitAndTrim(`${body}; SELECT 2;`)).toEqual([body, "SELECT 2"]);
    },
  );

  it("does not treat a BEGIN keyword followed by a non-ASCII identifier as BEGIN ATOMIC", () => {
    // `atomıc` (dotless ı) uppercases to `ATOMIC` in JS but is a plain identifier in SQL.
    expect(splitAndTrim("BEGIN atomıc; SELECT 'end'; SELECT 2;")).toEqual([
      "BEGIN atomıc",
      "SELECT 'end'",
      "SELECT 2",
    ]);
  });

  it("closes a BEGIN ATOMIC body at an END confirmed by a newline", () => {
    const body = "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END";
    expect(splitAndTrim(`${body}\n; SELECT 2;`)).toEqual([body, "SELECT 2"]);
  });

  it("keeps a BEGIN ATOMIC body whose END sits at EOF", () => {
    expect(splitAndTrim("begin atomic; select 'end'; end")).toEqual([
      "begin atomic; select 'end'; end",
    ]);
  });

  it("closes a BEGIN ATOMIC body at an END right after a positional parameter's ;", () => {
    const body = "CREATE FUNCTION f(int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT $1;END";
    expect(splitAndTrim(`${body}; SELECT 2;`)).toEqual([body, "SELECT 2"]);
  });

  it.each(["\u00A0", "\uFEFF", "\u0085"])(
    "does not treat BEGIN %s ATOMIC as the keyword pair",
    (gap) => {
      // Only PostgreSQL's own whitespace separates the keywords; these are identifier characters.
      const sql = `BEGIN ${gap} ATOMIC; SELECT 1; end; SELECT 2;`;
      expect(splitAndTrim(sql)).toEqual([`BEGIN ${gap} ATOMIC`, "SELECT 1", "end", "SELECT 2"]);
    },
  );

  it("closes a nested BEGIN ATOMIC body inside parentheses", () => {
    expect(splitAndTrim("DO (BEGIN ATOMIC SELECT 1; END; ); SELECT 2;")).toEqual([
      "DO (BEGIN ATOMIC SELECT 1; END; )",
      "SELECT 2",
    ]);
  });

  it("does not close a BEGIN ATOMIC body at an END after an overlapping block comment", () => {
    const body =
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; /* a /*/ b */ SELECT 2 END; SELECT 3; END";
    expect(splitAndTrim(`${body}; SELECT 4;`)).toEqual([body, "SELECT 4"]);
  });

  it.each([
    ["dollar-quoted body", "$$", "$$"],
    ["block comment", "/*", "*/"],
  ])("splits a 1 MB %s without quadratic slowdown", (_, open, close) => {
    const statement = `DO ${open}\n${"SELECT 1;\n".repeat(100_000)}${close}`;
    expect(splitAndTrim(`${statement}; SELECT 2;`)).toEqual([statement, "SELECT 2"]);
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
