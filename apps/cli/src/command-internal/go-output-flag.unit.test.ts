import { describe, expect, it } from "@effect/vitest";
import {
  QUERY_OUTPUT_FORMATS,
  RESOURCE_OUTPUT_FORMATS,
  invalidOutputFormatMessage,
  outputFormatEnumMessage,
  unsupportedOutputFlagMessage,
} from "./go-output-flag.ts";

describe("go-output-flag", () => {
  it("joins the allowed set with the ` | ` bracket format", () => {
    expect(outputFormatEnumMessage(RESOURCE_OUTPUT_FORMATS)).toBe(
      "must be one of [ env | pretty | json | toml | yaml ]",
    );
    expect(outputFormatEnumMessage(QUERY_OUTPUT_FORMATS)).toBe(
      "must be one of [ json | table | csv ]",
    );
  });

  it("formats the rejection message with the shorthand-prefixed flag name", () => {
    expect(invalidOutputFormatMessage("table", RESOURCE_OUTPUT_FORMATS)).toBe(
      'invalid argument "table" for "-o, --output" flag: must be one of [ env | pretty | json | toml | yaml ]',
    );
    expect(invalidOutputFormatMessage("yaml", QUERY_OUTPUT_FORMATS)).toBe(
      'invalid argument "yaml" for "-o, --output" flag: must be one of [ json | table | csv ]',
    );
  });

  it("directs unsupported commands to --output-format", () => {
    expect(unsupportedOutputFlagMessage("whoami")).toBe(
      "the -o/--output flag is not supported by whoami; use --output-format json|stream-json instead.",
    );
    expect(unsupportedOutputFlagMessage("pull")).toBe(
      "the -o/--output flag is not supported by pull; use --output-format json|stream-json instead.",
    );
    expect(unsupportedOutputFlagMessage("config diff")).toBe(
      "the -o/--output flag is not supported by config diff; use --output-format json|stream-json instead.",
    );
    expect(unsupportedOutputFlagMessage("config pull")).toBe(
      "the -o/--output flag is not supported by config pull; use --output-format json|stream-json instead.",
    );
  });
});
