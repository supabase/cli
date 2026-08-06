import { describe, expect, it } from "vitest";

import { legacyResolvePgDeltaImplementation } from "./legacy-pgdelta-next-flag.ts";

describe("legacyResolvePgDeltaImplementation", () => {
  it("defaults to the next implementation when unset", () => {
    expect(legacyResolvePgDeltaImplementation(undefined)).toBe("next");
  });

  it.each(["1", "t", "TRUE", "true", "True", "yes", "on", "", "garbage"])(
    "selects the next implementation for %j",
    (raw) => {
      expect(legacyResolvePgDeltaImplementation(raw)).toBe("next");
    },
  );

  it.each(["0", "f", "F", "FALSE", "false", "False"])(
    "selects the legacy implementation for %s",
    (raw) => {
      expect(legacyResolvePgDeltaImplementation(raw)).toBe("legacy");
    },
  );
});
