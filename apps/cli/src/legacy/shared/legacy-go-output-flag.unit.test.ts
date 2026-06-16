import { describe, expect, it } from "@effect/vitest";
import {
  LEGACY_QUERY_OUTPUT_FORMATS,
  LEGACY_RESOURCE_OUTPUT_FORMATS,
  legacyInvalidOutputFormatMessage,
  legacyOutputFormatEnumMessage,
} from "./legacy-go-output-flag.ts";

describe("legacy-go-output-flag", () => {
  it("joins the allowed set with Go's ` | ` bracket format", () => {
    expect(legacyOutputFormatEnumMessage(LEGACY_RESOURCE_OUTPUT_FORMATS)).toBe(
      "must be one of [ env | pretty | json | toml | yaml ]",
    );
    expect(legacyOutputFormatEnumMessage(LEGACY_QUERY_OUTPUT_FORMATS)).toBe(
      "must be one of [ json | table | csv ]",
    );
  });

  it("reproduces Go's pflag rejection message byte-for-byte", () => {
    // pflag: `invalid argument %q for %q flag: %v`, shorthand-prefixed `-o, --output`.
    expect(legacyInvalidOutputFormatMessage("table", LEGACY_RESOURCE_OUTPUT_FORMATS)).toBe(
      'invalid argument "table" for "-o, --output" flag: must be one of [ env | pretty | json | toml | yaml ]',
    );
    expect(legacyInvalidOutputFormatMessage("yaml", LEGACY_QUERY_OUTPUT_FORMATS)).toBe(
      'invalid argument "yaml" for "-o, --output" flag: must be one of [ json | table | csv ]',
    );
  });
});
