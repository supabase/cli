import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { legacyMigrationsEnabled } from "./legacy-migrations-enabled.ts";

describe("legacyMigrationsEnabled", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env["SUPABASE_DB_MIGRATIONS_ENABLED"];
    delete process.env["SUPABASE_DB_MIGRATIONS_ENABLED"];
  });

  afterEach(() => {
    if (previous === undefined) delete process.env["SUPABASE_DB_MIGRATIONS_ENABLED"];
    else process.env["SUPABASE_DB_MIGRATIONS_ENABLED"] = previous;
  });

  it("uses the config value when the env override is unset", () => {
    expect(legacyMigrationsEnabled(true)).toBe(true);
    expect(legacyMigrationsEnabled(false)).toBe(false);
  });

  it("lets SUPABASE_DB_MIGRATIONS_ENABLED override the config value (Go viper AutomaticEnv)", () => {
    for (const truthy of ["1", "t", "T", "TRUE", "true", "True"]) {
      process.env["SUPABASE_DB_MIGRATIONS_ENABLED"] = truthy;
      expect(legacyMigrationsEnabled(false)).toBe(true);
    }
    for (const falsy of ["0", "false", "False", "FALSE", "no", "", "garbage"]) {
      process.env["SUPABASE_DB_MIGRATIONS_ENABLED"] = falsy;
      expect(legacyMigrationsEnabled(true)).toBe(false);
    }
  });
});
