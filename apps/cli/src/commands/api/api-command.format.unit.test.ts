import { describe, expect, it } from "@effect/vitest";
import { renderResponseText } from "./api-command.format.ts";

describe("renderResponseText", () => {
  it("keeps known acronyms upper-case in labels", () => {
    expect(renderResponseText({ project_id: "p", base_url: "u", fdw_name: "f", name: "n" })).toBe(
      ["Project ID  p", "Base URL    u", "FDW name    f", "Name        n", ""].join("\n"),
    );
  });

  it("escapes line breaks and control characters so every value stays on one line", () => {
    expect(renderResponseText({ message: "a\nb\tc\u0001d" })).toBe("Message  a\\nb\\tc\\u0001d\n");
  });

  it("escapes control characters in keys so labels stay on one line", () => {
    expect(renderResponseText({ "a\nb\u001bc": 1 })).toBe("A\\nb\\u001bc  1\n");
  });

  it("prints a dash for null and empty strings, arrays and objects", () => {
    expect(renderResponseText({ owner: null, note: "", tags: [], limits: {} })).toBe(
      ["Owner   -", "Note    -", "Tags    -", "Limits  -", ""].join("\n"),
    );
  });

  it("joins arrays of scalars with commas", () => {
    expect(renderResponseText({ regions: ["eu", "us"], flags: [true, false] })).toBe(
      ["Regions  eu, us", "Flags    yes, no", ""].join("\n"),
    );
  });

  it("indents nested objects under their label", () => {
    expect(renderResponseText({ name: "n", limits: { max: 1, nested: { deep: true } } })).toBe(
      ["Name  n", "Limits", "  Max  1", "  Nested", "    Deep  yes", ""].join("\n"),
    );
  });
});
