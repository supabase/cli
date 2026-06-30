import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { legacyMigrationsEnabled, legacySeedEnabled } from "./legacy-config-env-override.ts";

const ENV_KEYS = ["SUPABASE_DB_MIGRATIONS_ENABLED", "SUPABASE_DB_SEED_ENABLED"] as const;

describe("legacy config bool env overrides", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const prev = saved.get(key);
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  it("uses the config value when the env override is unset", () => {
    expect(legacyMigrationsEnabled(true)).toBe(true);
    expect(legacyMigrationsEnabled(false)).toBe(false);
    expect(legacySeedEnabled(true)).toBe(true);
    expect(legacySeedEnabled(false)).toBe(false);
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

  it("lets SUPABASE_DB_SEED_ENABLED override the config value (Go viper AutomaticEnv)", () => {
    process.env["SUPABASE_DB_SEED_ENABLED"] = "false";
    expect(legacySeedEnabled(true)).toBe(false);
    process.env["SUPABASE_DB_SEED_ENABLED"] = "true";
    expect(legacySeedEnabled(false)).toBe(true);
  });
});
