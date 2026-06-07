import { describe, expect, it } from "vitest";
import { assertTableParity, parseTable } from "./parity.ts";

// Helpers — build table output strings in the Go CLI format
function makeTableOutput(headers: string[], rows: string[][]): string {
  const headerRow = "   " + headers.join(" | ");
  const separator = "  " + headers.map((h) => "-".repeat(h.length)).join("-|-");
  const dataRows = rows.map((cells) => "   " + cells.join(" | "));
  return ["\n  ", headerRow, separator, ...dataRows, ""].join("\n");
}

describe("parseTable", () => {
  it("parses a typical Go CLI table with headers and data rows", () => {
    const output = makeTableOutput(
      ["ID", "NAME"],
      [
        ["<PROJECT_REF_1>", "My Org"],
        ["<PROJECT_REF_2>", "Other Org"],
      ],
    );
    const result = parseTable(output);
    expect(result.headers).toEqual(["ID", "NAME"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual(["<PROJECT_REF_1>", "My Org"]);
    expect(result.rows[1]).toEqual(["<PROJECT_REF_2>", "Other Org"]);
  });

  it("returns empty table for output with no separator line", () => {
    expect(parseTable("no table here")).toEqual({ headers: [], rows: [] });
    expect(parseTable("")).toEqual({ headers: [], rows: [] });
    expect(parseTable("some output\nwithout a table")).toEqual({ headers: [], rows: [] });
  });

  it("returns empty rows for a table that has headers but no data", () => {
    const output = makeTableOutput(
      ["ID", "NAME", "STATUS"],
      [], // no data rows
    );
    const result = parseTable(output);
    expect(result.headers).toEqual(["ID", "NAME", "STATUS"]);
    expect(result.rows).toHaveLength(0);
  });

  it("trims whitespace from all header and cell values", () => {
    const output = [
      "   COLUMN1   |   COLUMN2   ",
      "  -----------|-------------",
      "   value 1   |   value 2   ",
    ].join("\n");
    const result = parseTable(output);
    expect(result.headers).toEqual(["COLUMN1", "COLUMN2"]);
    expect(result.rows[0]).toEqual(["value 1", "value 2"]);
  });

  it("handles the actual Go CLI output format for projects list", () => {
    const output =
      "\n  \n   REFERENCE ID         | NAME                              | REGION       | CREATED AT (UTC) \n  ----------------------|------------------------------------|--------------|------------------\n   <PROJECT_REF_1>      | colum.ferry@supabase.io's Project | us-east-1    | <TIMESTAMP_1>    \n\n";
    const result = parseTable(output);
    expect(result.headers).toEqual(["REFERENCE ID", "NAME", "REGION", "CREATED AT (UTC)"]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.[0]).toBe("<PROJECT_REF_1>");
  });

  it("handles the empty-result format (header + separator, no rows)", () => {
    const output = "\n  \n   ID | NAME | STATUS \n  ----|------|--------\n\n";
    const result = parseTable(output);
    expect(result.headers).toEqual(["ID", "NAME", "STATUS"]);
    expect(result.rows).toHaveLength(0);
  });
});

describe("assertTableParity", () => {
  it("passes when tables are identical", () => {
    const table = parseTable(makeTableOutput(["ID", "NAME"], [["<PROJECT_REF_1>", "Org"]]));
    expect(() => assertTableParity(table, table)).not.toThrow();
  });

  it("throws on header mismatch", () => {
    const go = { headers: ["ID", "NAME"], rows: [] };
    const ts = { headers: ["id", "name"], rows: [] };
    expect(() => assertTableParity(go, ts)).toThrow("Table header mismatch");
  });

  it("throws on row count mismatch", () => {
    const go = { headers: ["ID"], rows: [["a"], ["b"]] };
    const ts = { headers: ["ID"], rows: [["a"]] };
    expect(() => assertTableParity(go, ts)).toThrow("Table row count mismatch");
  });

  it("throws on row content mismatch", () => {
    const go = { headers: ["ID"], rows: [["ref-a"]] };
    const ts = { headers: ["ID"], rows: [["ref-b"]] };
    expect(() => assertTableParity(go, ts)).toThrow("Table row 0 mismatch");
  });

  it("includes context string in error message when provided", () => {
    const go = { headers: ["A"], rows: [] };
    const ts = { headers: ["B"], rows: [] };
    expect(() => assertTableParity(go, ts, "projects list")).toThrow("[projects list]");
  });
});
