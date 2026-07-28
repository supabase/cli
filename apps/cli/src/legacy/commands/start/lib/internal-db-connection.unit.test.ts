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
});

describe("legacyStartInternalDbUrl", () => {
  test("builds a role-specific internal connection string on the fixed port/database", () => {
    expect(legacyStartInternalDbUrl("authenticator", "supabase_db_proj", "postgres")).toBe(
      `postgresql://authenticator:postgres@supabase_db_proj:${LEGACY_START_INTERNAL_DB_PORT}/${LEGACY_START_INTERNAL_DB_NAME}`,
    );
  });

  test("port and database name are always the fixed internal values", () => {
    expect(LEGACY_START_INTERNAL_DB_PORT).toBe(5432);
    expect(LEGACY_START_INTERNAL_DB_NAME).toBe("postgres");
  });
});
