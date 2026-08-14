import { describe, expect, it } from "vitest";

import {
  legacyIsPgNetUnavailableError,
  legacyStatementInstallsPgNet,
} from "./legacy-pg-net-guidance.ts";

describe("legacyIsPgNetUnavailableError", () => {
  it("matches only the pg_net-specific undefined schema and function failures", () => {
    expect(
      legacyIsPgNetUnavailableError({ code: "3F000", message: 'schema "net" does not exist' }),
    ).toBe(true);
    expect(
      legacyIsPgNetUnavailableError({
        code: "42883",
        message: "function net.http_post(url => text) does not exist",
      }),
    ).toBe(true);
    // Right message, wrong SQLSTATE — a client-side echo, not a server verdict.
    expect(
      legacyIsPgNetUnavailableError({ code: "42P01", message: 'schema "net" does not exist' }),
    ).toBe(false);
    // Right SQLSTATE, unrelated object.
    expect(
      legacyIsPgNetUnavailableError({ code: "3F000", message: 'schema "audit" does not exist' }),
    ).toBe(false);
    expect(legacyIsPgNetUnavailableError({ message: 'schema "net" does not exist' })).toBe(false);
  });
});

/**
 * This predicate only ever gates AWAY from dropping pg_net, so it must be
 * generous: every plausible spelling of an install counts, and no false negative
 * is acceptable.
 */
describe("legacyStatementInstallsPgNet", () => {
  it.each([
    "create extension pg_net",
    "CREATE EXTENSION pg_net",
    "create extension if not exists pg_net schema extensions",
    'CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA extensions',
    "create\n  extension if not exists\n  pg_net\n  with schema extensions",
  ])("treats %j as a pg_net install", (statement) => {
    expect(legacyStatementInstallsPgNet(statement)).toBe(true);
  });

  it.each([
    "create table public.items (id int)",
    "create extension pgcrypto",
    "drop extension if exists pg_net",
    "select net.http_post(url := 'https://example.com')",
    "comment on extension pgcrypto is 'pg_net is not installed here'",
  ])("does not treat %j as a pg_net install", (statement) => {
    expect(legacyStatementInstallsPgNet(statement)).toBe(false);
  });
});
