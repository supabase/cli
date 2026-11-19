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

  it("prints a clear line for an empty resource collection", () => {
    expect(renderResponseText({ data: [] })).toBe("No results\n");
  });

  it.each([
    { name: "scalar", item: (index: number): unknown => `sample-${index}` },
    { name: "object", item: (index: number): unknown => ({ value: `sample-${index}` }) },
  ])("shows the last 10 $name samples of a points series in response order", ({ item }) => {
    const points = Array.from({ length: 12 }, (_, index) => item(index));
    const output = renderResponseText({ points });
    expect(output).not.toMatch(/sample-[01]\b/);
    expect(output.indexOf("sample-2")).toBeGreaterThanOrEqual(0);
    expect(output.indexOf("sample-2")).toBeLessThan(output.indexOf("sample-11"));
    expect(output).toContain(
      "Showing last 10 of 12 samples; 2 omitted; use -o json for all samples.",
    );
    expect(renderResponseText({ points: points.slice(2) })).not.toContain("omitted");
  });

  it("bounds points series nested inside a top-level array of objects", () => {
    const points = Array.from({ length: 12 }, (_, index) => `point-${index}`);
    const output = renderResponseText([{ points }]);
    expect(output).not.toMatch(/point-[01]\b/);
    expect(output).toContain("point-11");
    expect(output).toContain("2 omitted");
  });

  it("renders every item of an array that is not a points series", () => {
    const tables = Array.from({ length: 12 }, (_, index) => ({ name: `table-${index}` }));
    const output = renderResponseText({ tables });
    expect(output).toContain("table-0");
    expect(output).toContain("table-11");
    expect(output).not.toContain("omitted");
  });
});
