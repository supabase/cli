import { describe, expect, test } from "vitest";

import {
  LEGACY_START_INTERNAL_DB_NAME,
  LEGACY_START_INTERNAL_DB_PORT,
  legacyStartInternalDbPassword,
  legacyStartInternalDbUrl,
} from "./internal-db-connection.ts";

describe("legacyStartInternalDbPassword", () => {
  test("extracts the password component from a resolved dbUrl", () => {
    expect(
      legacyStartInternalDbPassword("postgresql://postgres:postgres@127.0.0.1:54322/postgres"),
    ).toBe("postgres");
  });

  test("extracts a non-default password", () => {
    expect(
      legacyStartInternalDbPassword("postgresql://postgres:super-secret@127.0.0.1:54322/postgres"),
    ).toBe("super-secret");
  });

  // The shadow path builds dbUrl via legacyToPostgresURL, which encodeURIComponent's a
  // config-derived password; plain-env consumers (Realtime's DB_PASSWORD) need the raw
  // value back or auth fails against a container initialized with the decoded form.
  test("percent-decodes an encoded password back to its raw value", () => {
    expect(
      legacyStartInternalDbPassword("postgresql://postgres:p%40ss%2Fw0rd@127.0.0.1:54322/postgres"),
    ).toBe("p@ss/w0rd");
  });

  test("falls back to the undecoded octets when userinfo was never percent-encoded", () => {
    expect(
      legacyStartInternalDbPassword("postgresql://postgres:100%pass@127.0.0.1:54322/postgres"),
    ).toBe("100%pass");
  });
});

describe("legacyStartInternalDbUrl", () => {
  test("builds a role-specific internal connection string on the fixed port/database", () => {
    expect(legacyStartInternalDbUrl("authenticator", "supabase_db_proj", "postgres")).toBe(
      `postgresql://authenticator:postgres@supabase_db_proj:${LEGACY_START_INTERNAL_DB_PORT}/${LEGACY_START_INTERNAL_DB_NAME}`,
    );
  });

  test("percent-encodes a raw password so the consuming URI parser decodes it back", () => {
    expect(legacyStartInternalDbUrl("authenticator", "supabase_db_proj", "p@ss/w0rd")).toBe(
      `postgresql://authenticator:p%40ss%2Fw0rd@supabase_db_proj:${LEGACY_START_INTERNAL_DB_PORT}/${LEGACY_START_INTERNAL_DB_NAME}`,
    );
  });

  test("port and database name are always the fixed internal values", () => {
    expect(LEGACY_START_INTERNAL_DB_PORT).toBe(5432);
    expect(LEGACY_START_INTERNAL_DB_NAME).toBe("postgres");
  });
});
