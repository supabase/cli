import { describe, expect, it } from "vitest";

import { findReadOnlyViolation } from "./query.read-only.ts";

describe("findReadOnlyViolation", () => {
  it.each([
    ["BEGIN", "BEGIN"],
    ["begin read write", "BEGIN"],
    ["START TRANSACTION ISOLATION LEVEL SERIALIZABLE", "START TRANSACTION"],
    ["start\n\ttransaction", "START TRANSACTION"],
    ["COMMIT", "COMMIT"],
    ["commit and chain", "COMMIT"],
    ["COMMIT PREPARED 'tx'", "COMMIT"],
    ["END", "END"],
    ["ABORT", "ABORT"],
    ["ROLLBACK", "ROLLBACK"],
    ["ROLLBACK TO SAVEPOINT s", "ROLLBACK"],
    ["ROLLBACK PREPARED 'tx'", "ROLLBACK"],
    ["PREPARE TRANSACTION 'tx'", "PREPARE TRANSACTION"],
  ])("rejects transaction control: %s", (sql, found) => {
    expect(findReadOnlyViolation(sql)).toBe(found);
  });

  it.each([
    ["SET TRANSACTION READ WRITE", "SET TRANSACTION"],
    ["set transaction isolation level serializable", "SET TRANSACTION"],
    ["SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE", "SET SESSION CHARACTERISTICS"],
    ["SET default_transaction_read_only = off", "SET default_transaction_read_only"],
    ["SET SESSION default_transaction_read_only TO off", "SET default_transaction_read_only"],
    ["SET LOCAL default_transaction_read_only = off", "SET default_transaction_read_only"],
    ["SET transaction_read_only = off", "SET transaction_read_only"],
    ["SET LOCAL TRANSACTION_READ_ONLY TO DEFAULT", "SET transaction_read_only"],
    ['SET "Transaction_Read_Only" = off', "SET transaction_read_only"],
    ['SET U&"transaction\\005fread\\005fonly" = off', 'SET U&"..."'],
    ["RESET default_transaction_read_only", "RESET default_transaction_read_only"],
    ["RESET transaction_read_only", "RESET transaction_read_only"],
    ["RESET ALL", "RESET ALL"],
    ["reset\nall", "RESET ALL"],
  ])("rejects read-only characteristic changes: %s", (sql, found) => {
    expect(findReadOnlyViolation(sql)).toBe(found);
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
    ["comment between keywords", "SET /* rw */ TRANSACTION READ WRITE"],
    ["comment before the setting", "SET -- rw\n transaction_read_only = off"],
  ])("sees through a %s", (_name, sql) => {
    expect(findReadOnlyViolation(sql)).toBeDefined();
  });

  it("finds a rejected statement after other statements", () => {
    expect(findReadOnlyViolation("SELECT 1; select 2; /* x */ COMMIT; DELETE FROM users")).toBe(
      "COMMIT",
    );
    expect(findReadOnlyViolation("SELECT 1;\n-- c\nset transaction read write;\nSELECT 2")).toBe(
      "SET TRANSACTION",
    );
  });

  it.each([
    ["a keyword inside a string", "SELECT 'COMMIT; SET TRANSACTION READ WRITE'"],
    ["a keyword inside an escape string", String.raw`SELECT E'it\'s; COMMIT; --'`],
    ["a keyword inside a dollar quote", "SELECT $$COMMIT; ROLLBACK$$"],
    ["a keyword inside a tagged dollar quote", "SELECT $q$; BEGIN; COMMIT; $q$"],
    ["a keyword inside a line comment", "SELECT 1 -- COMMIT\n; SELECT 2"],
    ["a keyword inside a block comment", "SELECT 1 /* ROLLBACK; */ ; SELECT 2"],
    ["a statement that is only a comment", "-- COMMIT"],
    ["an unterminated block comment", "/* COMMIT"],
    ["a keyword as a quoted identifier", 'SELECT "commit", "begin" FROM t'],
    ["a keyword as a column", "SELECT begin, commit, rollback FROM t"],
    ["an identifier that starts with a keyword", "COMMITTED_ROWS"],
    ["an identifier that starts with BEGIN", "BEGINNERS"],
    ["a function body", "CREATE FUNCTION f() RETURNS void LANGUAGE sql BEGIN ATOMIC SELECT 1; END"],
    [
      "a plpgsql body",
      "DO $$ BEGIN PERFORM set_config('transaction_read_only', 'off', true); END $$",
    ],
    ["set_config", "SELECT set_config('default_transaction_read_only', 'off', false)"],
    ["current_setting", "SELECT current_setting('transaction_read_only')"],
    ["an unrelated SET", "SET search_path TO public"],
    ["an unrelated SET LOCAL", "SET LOCAL statement_timeout = '5s'"],
    ["SET SESSION AUTHORIZATION", "SET SESSION AUTHORIZATION postgres"],
    ["an unrelated RESET", "RESET search_path"],
    ["a similarly named setting", "SET transaction_read_only_hint = 1"],
    ["a custom setting", "SET my.transaction_read_only = 1"],
    ["a SAVEPOINT", "SAVEPOINT s; RELEASE SAVEPOINT s"],
    ["a PREPARE of a query", "PREPARE q AS SELECT 1"],
    ["START as an identifier", "START_DATE"],
    ["a plain multi-statement read", "SELECT 1; SELECT 2;\nWITH t AS (SELECT 1) SELECT * FROM t"],
    ["an empty statement", ";;"],
    ["blank SQL", "  \n"],
  ])("lets through %s", (_name, sql) => {
    expect(findReadOnlyViolation(sql)).toBeUndefined();
  });
});
