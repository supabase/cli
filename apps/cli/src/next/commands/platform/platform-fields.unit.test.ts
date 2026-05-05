import { describe, expect, it } from "vitest";
import { Option } from "effect";

import {
  parsePlatformFieldsSelection,
  projectPlatformFields,
  renderPlatformValue,
} from "./platform-fields.ts";

describe("platform fields", () => {
  it("parses comma-separated field selections", () => {
    expect(parsePlatformFieldsSelection(Option.some("ref, status ,nested.value"))).toEqual([
      "ref",
      "status",
      "nested.value",
    ]);
  });

  it("projects nested fields from an object response", () => {
    const result = projectPlatformFields(
      {
        ref: "abcd1234",
        name: "my-project",
        nested: { value: "kept", ignored: "dropped" },
      },
      ["ref", "nested.value"],
    );

    expect(result).toEqual({
      ref: "abcd1234",
      nested: { value: "kept" },
    });
  });

  it("renders generic text output", () => {
    const rendered = renderPlatformValue({
      ref: "abcd1234",
      status: "ACTIVE_HEALTHY",
    });

    expect(rendered).toContain("ref: abcd1234");
    expect(rendered).toContain("status: ACTIVE_HEALTHY");
  });
});
