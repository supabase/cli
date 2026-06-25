import { afterEach, describe, expect, it } from "vitest";

import { legacyViperEnvBool } from "./legacy-viper-env.ts";

const KEY = "SUPABASE_TEST_VIPER_BOOL";

describe("legacyViperEnvBool", () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  it("is true only for strconv.ParseBool's true set (viper.GetBool parity)", () => {
    for (const value of ["1", "t", "T", "TRUE", "true", "True"]) {
      process.env[KEY] = value;
      expect(legacyViperEnvBool(KEY)).toBe(true);
    }
  });

  it("is false for the false set and any unrecognized value", () => {
    // viper casts via strconv.ParseBool and swallows the error to `false`, so
    // `yes`/`on`/`""`/garbage are NOT truthy (unlike some bool parsers).
    for (const value of ["0", "f", "F", "FALSE", "false", "False", "yes", "on", "", "nope"]) {
      process.env[KEY] = value;
      expect(legacyViperEnvBool(KEY)).toBe(false);
    }
  });

  it("is false when the env var is absent", () => {
    delete process.env[KEY];
    expect(legacyViperEnvBool(KEY)).toBe(false);
  });
});
