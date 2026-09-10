import { describe, expect, it } from "vitest";

import { isPgNetUnavailableError, statementInstallsPgNet } from "./pg-net-guidance.ts";

describe("isPgNetUnavailableError", () => {
  it("matches only the pg_net-specific undefined schema and function failures", () => {
    expect(isPgNetUnavailableError({ code: "3F000", message: 'schema "net" does not exist' })).toBe(
      true,
    );
    expect(
      isPgNetUnavailableError({
        code: "42883",
        message: "function net.http_post(url => text) does not exist",
      }),
    ).toBe(true);
    expect(isPgNetUnavailableError({ code: "42P01", message: 'schema "net" does not exist' })).toBe(
      false,
    );
    expect(
      isPgNetUnavailableError({ code: "3F000", message: 'schema "audit" does not exist' }),
    ).toBe(false);
    expect(isPgNetUnavailableError({ message: 'schema "net" does not exist' })).toBe(false);
  });
});

describe("statementInstallsPgNet", () => {
  it.each([
    "create extension pg_net",
    'CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA extensions',
    "create\n  extension if not exists\n  pg_net\n  with schema extensions",
  ])("treats %j as a pg_net install", (statement) => {
    expect(statementInstallsPgNet(statement)).toBe(true);
  });

  it.each([
    "create extension pgcrypto",
    "drop extension if exists pg_net",
    "comment on extension pgcrypto is 'pg_net is not installed here'",
  ])("does not treat %j as a pg_net install", (statement) => {
    expect(statementInstallsPgNet(statement)).toBe(false);
  });
});
