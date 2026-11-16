import { describe, expect, it } from "vitest";

import { findReadOnlyViolation } from "./query.read-only.ts";

const UNRECOGNISED = "an unrecognised statement";
const UNTERMINATED = "an unterminated comment, quote or dollar quote";

describe("findReadOnlyViolation", () => {
  it.each([
    ["BEGIN", "BEGIN"],
    ["begin read write", "BEGIN"],
    ["START TRANSACTION ISOLATION LEVEL SERIALIZABLE", "START"],
    ["COMMIT", "COMMIT"],
    ["commit and chain", "COMMIT"],
    ["COMMIT PREPARED 'tx'", "COMMIT"],
    ["END", "END"],
    ["ABORT", "ABORT"],
    ["ROLLBACK TO SAVEPOINT s", "ROLLBACK"],
    ["PREPARE TRANSACTION 'tx'", "PREPARE"],
    ["SAVEPOINT s", "SAVEPOINT"],
    ["RELEASE SAVEPOINT s", "RELEASE"],
  ])("rejects transaction control: %s", (sql, label) => {
    expect(findReadOnlyViolation(sql)).toBe(label);
  });

  it.each([
    "SET TRANSACTION READ WRITE",
    "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
    "SET default_transaction_read_only = off",
    "SET LOCAL transaction_read_only TO off",
    'SET U&"transaction\\005fread\\005fonly" = off',
    "SET ROLE postgres",
    "SET SESSION AUTHORIZATION postgres",
    "SET search_path TO public",
    "SET LOCAL statement_timeout = '5s'",
    "SET LOCAL lock_timeout = 0",
  ])("rejects SET: %s", (sql) => {
    expect(findReadOnlyViolation(sql)).toBe("SET");
  });

  it.each([
    ["RESET ALL", "RESET"],
    ["RESET transaction_read_only", "RESET"],
    ["CLUSTER t", "CLUSTER"],
    ["REINDEX TABLE t", "REINDEX"],
    ["LOCK TABLE t IN ACCESS EXCLUSIVE MODE", "LOCK"],
    ["ANALYZE t", "ANALYZE"],
    ["VACUUM t", "VACUUM"],
    ["NOTIFY chan", "NOTIFY"],
    ["LISTEN chan", "LISTEN"],
    ["COPY t TO STDOUT", "COPY"],
    ["CALL p()", "CALL"],
    ["DO $$ BEGIN PERFORM 1; END $$", "DO"],
    ["INSERT INTO t VALUES (1)", "INSERT"],
    ["update t set a = 1", "UPDATE"],
    ["DELETE FROM t", "DELETE"],
    ["MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE", "MERGE"],
    ["TRUNCATE t", "TRUNCATE"],
    ["CREATE TABLE t ()", "CREATE"],
    ["ALTER TABLE t ADD COLUMN c int", "ALTER"],
    ["DROP TABLE t", "DROP"],
    ["GRANT SELECT ON t TO r", "GRANT"],
    ["PREPARE q AS SELECT 1", "PREPARE"],
    ["EXECUTE q", "EXECUTE"],
    ["DECLARE c CURSOR FOR SELECT 1", "DECLARE"],
    ["FETCH c", "FETCH"],
    ["DISCARD ALL", "DISCARD"],
    ["CHECKPOINT", "CHECKPOINT"],
  ])("rejects a statement that is not a read: %s", (sql, label) => {
    expect(findReadOnlyViolation(sql)).toBe(label);
  });

  it.each([
    ["an unknown word", "FROBNICATE t"],
    ["a quoted keyword", '"select" 1'],
    ["a keyword with a trailing identifier character", "SELECTx 1"],
    ["a keyword with a trailing digit", "SELECT1"],
    ["a non-ASCII lookalike of a keyword", "ſelect 1"],
    ["a string", "'SELECT 1'"],
    ["a number", "1"],
    ["a dollar quote", "$$SELECT 1$$"],
  ])("labels %s without echoing it", (_name, sql) => {
    expect(findReadOnlyViolation(sql)).toBe(UNRECOGNISED);
  });

  it.each([
    ["line comment", "-- note\nCOMMIT"],
    ["carriage-return line comment", "-- note\rCOMMIT"],
    ["block comment", "/* note */ COMMIT"],
    ["nested block comment", "/* a /* b */ c */ COMMIT"],
    ["stacked comments", "-- a\n/* b */\n-- c\nCOMMIT"],
    ["byte order mark", "﻿COMMIT"],
    ["byte order mark before a comment", "﻿-- note\nCOMMIT"],
    ["form feed", "\fCOMMIT"],
    ["nested comment closed by */ then *", "/* /* */* x */ COMMIT; DELETE FROM t; /* */"],
    ["comment opened by /*/", "/*/ x */ COMMIT"],
  ])("sees through a %s", (_name, sql) => {
    expect(findReadOnlyViolation(sql)).toBe("COMMIT");
  });

  it("still checks every statement after a parenthesised query", () => {
    expect(findReadOnlyViolation("(SELECT 1) UNION (SELECT 2); COMMIT")).toBe("COMMIT");
  });

  it("refuses a read-only setting change hidden after a nested comment", () => {
    expect(
      findReadOnlyViolation(
        "/* /* */* x */ SET default_transaction_read_only = off; DELETE FROM t",
      ),
    ).toBe("SET");
  });

  it("finds a rejected statement after other statements", () => {
    expect(findReadOnlyViolation("SELECT 1; select 2; /* x */ COMMIT; DELETE FROM users")).toBe(
      "COMMIT",
    );
    expect(findReadOnlyViolation("SELECT 1;\n-- c\nset transaction read write;\nSELECT 2")).toBe(
      "SET",
    );
  });

  it.each([
    "SELECT 1 /* COMMIT",
    "/* COMMIT",
    "SELECT 'COMMIT",
    "SELECT 1; SELECT 'a",
    'SELECT "a',
    "SELECT $$ COMMIT; DELETE FROM t",
    "SELECT $t$ COMMIT $$",
    "SELECT 1 /* a /* b */",
    String.raw`SELECT E'a\'`,
  ])("rejects input that ends inside a comment or quote: %s", (sql) => {
    expect(findReadOnlyViolation(sql)).toBe(UNTERMINATED);
  });

  it.each([
    "WITH begin AS (SELECT 1) SELECT * FROM begin atomic; COMMIT; DELETE FROM users; END",
    "WITH begin AS (SELECT 1) SELECT * FROM begin\n  ATOMIC; SET transaction_read_only = off; DELETE FROM users; END",
    "SELECT 1 FROM BEGIN \t\r\n ATOMIC; COMMIT; DELETE FROM users; END",
    "SELECT 'begin atomic' FROM begin atomic; COMMIT; DELETE FROM users; END",
    "SELECT 1 -- begin\natomic; COMMIT; DELETE FROM users; END",
  ])("rejects input containing BEGIN ATOMIC: %s", (sql) => {
    expect(findReadOnlyViolation(sql)).toBe("BEGIN ATOMIC");
  });

  it.each([
    ["SELECT", "SELECT 1"],
    ["a lowercase SELECT", "select 1"],
    ["WITH", "WITH t AS (SELECT 1) SELECT * FROM t"],
    [
      "WITH RECURSIVE",
      "with recursive t(n) as (select 1 union all select n + 1 from t) select n from t",
    ],
    ["VALUES", "VALUES (1), (2)"],
    ["TABLE", "TABLE users"],
    ["SHOW", "SHOW search_path"],
    ["SHOW ALL", "show all"],
    ["EXPLAIN", "EXPLAIN SELECT 1"],
    ["EXPLAIN ANALYZE", "EXPLAIN (ANALYZE, BUFFERS) SELECT 1"],
    ["a parenthesised query", "(SELECT 1) UNION (SELECT 2)"],
    ["a parenthesised query after a comment", "-- note\n/* a */ (VALUES (1))"],
    ["a keyword glued to a punctuation mark", "SELECT*FROM t"],
    ["a keyword after a line comment", "-- note\nSELECT 1"],
    ["a keyword after a nested block comment", "/* a /* b */ c */ SELECT 1"],
    ["a keyword after a byte order mark", "﻿SELECT 1"],
  ])("lets through %s", (_name, sql) => {
    expect(findReadOnlyViolation(sql)).toBeUndefined();
  });

  it.each([
    ["a keyword inside a string", "SELECT 'COMMIT; SET TRANSACTION READ WRITE'"],
    ["a keyword inside an escape string", String.raw`SELECT E'it\'s; COMMIT; --'`],
    ["a keyword inside a dollar quote", "SELECT $$COMMIT; ROLLBACK$$"],
    ["a keyword inside a tagged dollar quote", "SELECT $q$; BEGIN; COMMIT; $q$"],
    ["a keyword inside a line comment", "SELECT 1 -- COMMIT\n; SELECT 2"],
    ["a keyword inside a block comment", "SELECT 1 /* ROLLBACK; */ ; SELECT 2"],
    ["a keyword as a quoted identifier", 'SELECT "commit", "begin" FROM t'],
    ["BEGIN ATOMIC inside a string", "select 'begin atomic' as s"],
    ["BEGIN ATOMIC with a newline inside a string", "SELECT 'begin\n  atomic'"],
    ["BEGIN ATOMIC inside an escape string", String.raw`SELECT E'it\'s begin atomic'`],
    ["BEGIN ATOMIC inside a Unicode escape string", "SELECT U&'begin atomic'"],
    ["BEGIN ATOMIC inside a dollar quote", "SELECT $$begin atomic$$"],
    ["BEGIN ATOMIC inside a tagged dollar quote", "SELECT $q$begin atomic$q$"],
    ["BEGIN ATOMIC as a quoted identifier", 'select 1 as "begin atomic"'],
    ["BEGIN ATOMIC inside a line comment", "SELECT 1 -- begin atomic"],
    ["BEGIN ATOMIC inside a block comment", "select 1 /* begin atomic */"],
    ["BEGIN ATOMIC inside a nested block comment", "SELECT 1 /* a /* begin atomic */ b */"],
    ["a keyword as a column", "SELECT begin, commit, rollback FROM t"],
    ["set_config", "SELECT set_config('default_transaction_read_only', 'off', false)"],
    ["current_setting", "SELECT current_setting('transaction_read_only')"],
    ["a plain multi-statement read", "SELECT 1; SELECT 2;\nWITH t AS (SELECT 1) SELECT * FROM t"],
    ["a trailing line comment", "SELECT 1 -- COMMIT"],
    ["a trailing closed block comment", "SELECT 1 /* COMMIT */"],
    ["a statement that is only a comment", "-- COMMIT"],
    ["a statement that is only a closed block comment", "/* COMMIT */"],
    ["an empty statement", ";;"],
    ["blank SQL", "  \n"],
  ])("lets through %s", (_name, sql) => {
    expect(findReadOnlyViolation(sql)).toBeUndefined();
  });
});
