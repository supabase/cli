import { describe, expect, test } from "vitest";

import { legacyEnvOrDefault } from "./legacy-env-or-default.ts";

describe("legacyEnvOrDefault", () => {
  test('falls back to the default when unset anywhere (Go\'s "envOrDefault", start.go:1466-1471)', () => {
    expect(legacyEnvOrDefault("LEGACY_ENV_OR_DEFAULT_UNSET_KEY", "default", undefined)).toBe(
      "default",
    );
  });

  test("prefers a projectEnvValues (dotenv) value over the default", () => {
    expect(legacyEnvOrDefault("SOME_KEY", "default", { SOME_KEY: "from-dotenv" })).toBe(
      "from-dotenv",
    );
  });

  test("an override that is set but empty is used verbatim, matching os.LookupEnv (not treated as unset)", () => {
    expect(legacyEnvOrDefault("SOME_KEY", "default", { SOME_KEY: "" })).toBe("");
  });
});
