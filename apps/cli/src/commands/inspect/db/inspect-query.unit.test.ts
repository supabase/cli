import { describe, expect, it } from "vitest";

import {
  inspectBacktickStmt,
  inspectBool,
  inspectFloat1,
  inspectInt,
  inspectPlainText,
  inspectStmt,
  inspectText,
} from "./inspect-query.ts";
import { vacuumStatsSpec } from "./vacuum-stats/vacuum-stats.query.ts";

describe("inspectText (backtick-wrapped `%s`)", () => {
  it("passes a non-empty value through with its backticks stripped (glamour)", () => {
    expect(inspectText("hello")).toBe("hello");
    expect(inspectText(42)).toBe("42");
  });
  it("renders an empty/null value as the two literal backticks of an empty code span", () => {
    expect(inspectText("")).toBe("``");
    expect(inspectText(null)).toBe("``");
    expect(inspectText(undefined)).toBe("``");
  });
});

describe("inspectPlainText (unwrapped `%s`)", () => {
  it("passes strings through and renders null/undefined as empty", () => {
    expect(inspectPlainText("2024-01-01 00:00")).toBe("2024-01-01 00:00");
    expect(inspectPlainText("")).toBe("");
    expect(inspectPlainText(null)).toBe("");
    expect(inspectPlainText(undefined)).toBe("");
  });
});

describe("inspectBool (%t)", () => {
  it("renders booleans as true/false", () => {
    expect(inspectBool(true)).toBe("true");
    expect(inspectBool(false)).toBe("false");
  });
  it("treats null/undefined as the false zero value", () => {
    expect(inspectBool(null)).toBe("false");
    expect(inspectBool(undefined)).toBe("false");
  });
  it("stringifies any other type", () => {
    expect(inspectBool("t")).toBe("t");
  });
});

describe("inspectInt (%d)", () => {
  it("passes numbers, numeric strings, and bigints through in base 10", () => {
    expect(inspectInt(5)).toBe("5");
    expect(inspectInt("123")).toBe("123");
    expect(inspectInt(5n)).toBe("5");
  });
  it("renders null/undefined as the zero value", () => {
    expect(inspectInt(null)).toBe("0");
    expect(inspectInt(undefined)).toBe("0");
  });
  it("stringifies a non-finite number without throwing", () => {
    expect(inspectInt(Number.NaN)).toBe("NaN");
  });
});

describe("inspectFloat1 (%.1f)", () => {
  it("formats numbers, numeric strings, and bigints to one decimal", () => {
    expect(inspectFloat1(12)).toBe("12.0");
    expect(inspectFloat1(0.04)).toBe("0.0");
    expect(inspectFloat1("3")).toBe("3.0");
    expect(inspectFloat1(2n)).toBe("2.0");
  });
  it("renders null/undefined as the zero value", () => {
    expect(inspectFloat1(null)).toBe("0.0");
    expect(inspectFloat1(undefined)).toBe("0.0");
  });
  it("passes a non-numeric string through unchanged", () => {
    expect(inspectFloat1("n/a")).toBe("n/a");
  });
  it("stringifies any other type", () => {
    expect(inspectFloat1(true)).toBe("true");
  });
});

describe("inspectStmt (whitespace-collapsed %s)", () => {
  it("collapses every whitespace run to a single space", () => {
    expect(inspectStmt("a\n\tb  c")).toBe("a b c");
    expect(inspectStmt("SELECT\n  1")).toBe("SELECT 1");
  });
  it("renders null/undefined as empty", () => {
    expect(inspectStmt(null)).toBe("");
    expect(inspectStmt(undefined)).toBe("");
  });
  it("leaves a literal pipe in place (renderGlamourTable takes clean cells)", () => {
    expect(inspectStmt("a | b")).toBe("a | b");
  });
  it("replaces each vertical tab individually (Go's RE2 `\\s` excludes `\\v`)", () => {
    expect(inspectStmt("a\v\vb")).toBe("a  b");
    expect(inspectStmt("a \vb")).toBe("a  b");
  });
  it("leaves a non-breaking space untouched (not in Go's `\\s`)", () => {
    expect(inspectStmt("a b")).toBe("a b");
  });
});

describe("inspectBacktickStmt (backtick-wrapped, whitespace-collapsed `%s`)", () => {
  it("collapses whitespace like inspectStmt for a non-empty statement", () => {
    expect(inspectBacktickStmt("SELECT\n  1")).toBe("SELECT 1");
  });
  it("renders an empty/null statement as the two literal backticks", () => {
    expect(inspectBacktickStmt("")).toBe("``");
    expect(inspectBacktickStmt(null)).toBe("``");
    expect(inspectBacktickStmt(undefined)).toBe("``");
  });
});

describe("vacuumStatsSpec rowcount projection", () => {
  const cfg = {
    conn: {
      host: "127.0.0.1",
      port: 54322,
      user: "postgres",
      password: "postgres",
      database: "postgres",
    },
    isLocal: true,
  };
  const row = (rowcount: string) => ({
    name: "public.t",
    last_vacuum: "",
    last_autovacuum: "",
    last_analyze: "",
    last_autoanalyze: "",
    rowcount,
    dead_rowcount: "0",
    autovacuum_threshold: "0",
    expect_autovacuum: "no",
    autoanalyze_threshold: "0",
    expect_autoanalyze: "no",
  });

  it("replaces the first `-1` substring within the padded to_char output", () => {
    // `to_char(reltuples, '9G999G999G999')` right-justifies, so a -1 value comes back padded.
    const cells = vacuumStatsSpec.project(row("           -1"), cfg);
    expect(cells[5]).toBe("           No stats");
  });

  it("leaves a real formatted count untouched", () => {
    const cells = vacuumStatsSpec.project(row("    1,234,567"), cfg);
    expect(cells[5]).toBe("    1,234,567");
  });
});
