import { describe, expect, it } from "vitest";
import { legacyNormalizeSchemaFlags } from "./legacy-schema-flags.ts";

describe("legacyNormalizeSchemaFlags (pflag StringSlice CSV parity)", () => {
  it("splits unquoted comma-separated values", () => {
    expect(legacyNormalizeSchemaFlags(["public,private"])).toEqual(["public", "private"]);
  });

  it("keeps a quoted value with embedded comma as a single element", () => {
    // pflag TestSSWithComma: `"tenant,one"` → one element "tenant,one"
    expect(legacyNormalizeSchemaFlags(['"tenant,one"'])).toEqual(["tenant,one"]);
  });

  it("single value with no comma", () => {
    expect(legacyNormalizeSchemaFlags(["public"])).toEqual(["public"]);
  });

  it("accumulates repeated flags", () => {
    expect(legacyNormalizeSchemaFlags(["public", "private"])).toEqual(["public", "private"]);
  });

  it("accumulates repeated flags mixed with csv", () => {
    expect(legacyNormalizeSchemaFlags(["public,private", "staging"])).toEqual([
      "public",
      "private",
      "staging",
    ]);
  });

  it("unescapes doubled double-quote inside quoted field", () => {
    // Go csv: `"a""b"` → field is `a"b`
    expect(legacyNormalizeSchemaFlags(['"a""b"'])).toEqual(['a"b']);
  });

  it("empty input returns empty array", () => {
    expect(legacyNormalizeSchemaFlags([])).toEqual([]);
  });

  it("preserves whitespace (Go does not trim)", () => {
    // Go csv passes raw field values; pflag does not trim
    expect(legacyNormalizeSchemaFlags([" public , private "])).toEqual([" public ", " private "]);
  });
});
