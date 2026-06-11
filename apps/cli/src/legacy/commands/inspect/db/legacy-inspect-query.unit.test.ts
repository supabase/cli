import { describe, expect, it } from "vitest";

import {
  legacyInspectBacktickStmt,
  legacyInspectBool,
  legacyInspectFloat1,
  legacyInspectInt,
  legacyInspectPlainText,
  legacyInspectStmt,
  legacyInspectText,
} from "./legacy-inspect-query.ts";
import { legacyVacuumStatsSpec } from "./vacuum-stats/vacuum-stats.query.ts";

describe("legacyInspectText (backtick-wrapped `%s`)", () => {
  it("passes a non-empty value through with its backticks stripped (glamour)", () => {
    expect(legacyInspectText("hello")).toBe("hello");
    expect(legacyInspectText(42)).toBe("42");
  });
  it("renders an empty/null value as the two literal backticks of an empty code span", () => {
    // Go wraps the cell as `` `%s` ``; an empty code span isn't a valid token, so
    // glamour emits the two backtick characters literally (e.g. role-stats
    // `custom_config` for the `postgres` row). Matches `role_stats.go:43`.
    expect(legacyInspectText("")).toBe("``");
    expect(legacyInspectText(null)).toBe("``");
    expect(legacyInspectText(undefined)).toBe("``");
  });
});

describe("legacyInspectPlainText (unwrapped `%s`)", () => {
  it("passes strings through and renders null/undefined as empty", () => {
    // The unwrapped columns (vacuum_stats timestamps) have no code span, so an
    // empty value stays empty rather than `` `` ``.
    expect(legacyInspectPlainText("2024-01-01 00:00")).toBe("2024-01-01 00:00");
    expect(legacyInspectPlainText("")).toBe("");
    expect(legacyInspectPlainText(null)).toBe("");
    expect(legacyInspectPlainText(undefined)).toBe("");
  });
});

describe("legacyInspectBool (%t)", () => {
  it("renders booleans as true/false", () => {
    expect(legacyInspectBool(true)).toBe("true");
    expect(legacyInspectBool(false)).toBe("false");
  });
  it("treats null/undefined as the false zero value", () => {
    expect(legacyInspectBool(null)).toBe("false");
    expect(legacyInspectBool(undefined)).toBe("false");
  });
  it("stringifies any other type", () => {
    expect(legacyInspectBool("t")).toBe("t");
  });
});

describe("legacyInspectInt (%d)", () => {
  it("passes numbers, numeric strings, and bigints through in base 10", () => {
    expect(legacyInspectInt(5)).toBe("5");
    expect(legacyInspectInt("123")).toBe("123");
    expect(legacyInspectInt(5n)).toBe("5");
  });
  it("renders null/undefined as the zero value", () => {
    expect(legacyInspectInt(null)).toBe("0");
    expect(legacyInspectInt(undefined)).toBe("0");
  });
  it("stringifies a non-finite number without throwing", () => {
    expect(legacyInspectInt(Number.NaN)).toBe("NaN");
  });
});

describe("legacyInspectFloat1 (%.1f)", () => {
  it("formats numbers, numeric strings, and bigints to one decimal", () => {
    expect(legacyInspectFloat1(12)).toBe("12.0");
    expect(legacyInspectFloat1(0.04)).toBe("0.0");
    expect(legacyInspectFloat1("3")).toBe("3.0");
    expect(legacyInspectFloat1(2n)).toBe("2.0");
  });
  it("renders null/undefined as the zero value", () => {
    expect(legacyInspectFloat1(null)).toBe("0.0");
    expect(legacyInspectFloat1(undefined)).toBe("0.0");
  });
  it("passes a non-numeric string through unchanged", () => {
    expect(legacyInspectFloat1("n/a")).toBe("n/a");
  });
  it("stringifies any other type", () => {
    expect(legacyInspectFloat1(true)).toBe("true");
  });
});

describe("legacyInspectStmt (whitespace-collapsed %s)", () => {
  it("collapses every whitespace run to a single space", () => {
    expect(legacyInspectStmt("a\n\tb  c")).toBe("a b c");
    expect(legacyInspectStmt("SELECT\n  1")).toBe("SELECT 1");
  });
  it("renders null/undefined as empty", () => {
    expect(legacyInspectStmt(null)).toBe("");
    expect(legacyInspectStmt(undefined)).toBe("");
  });
  it("leaves a literal pipe in place (renderGlamourTable takes clean cells)", () => {
    expect(legacyInspectStmt("a | b")).toBe("a | b");
  });
  it("replaces each vertical tab individually (Go's RE2 `\\s` excludes `\\v`)", () => {
    // Go's regex appends `|\v` because RE2 `\s` does not match `\v`; consecutive
    // vertical tabs therefore collapse to one space each, not a single space.
    expect(legacyInspectStmt("a\v\vb")).toBe("a  b");
    // A space-then-vtab is a space run then an individual vtab → two spaces.
    expect(legacyInspectStmt("a \vb")).toBe("a  b");
  });
  it("leaves a non-breaking space untouched (not in Go's `\\s`)", () => {
    expect(legacyInspectStmt("a b")).toBe("a b");
  });
});

describe("legacyInspectBacktickStmt (backtick-wrapped, whitespace-collapsed `%s`)", () => {
  it("collapses whitespace like legacyInspectStmt for a non-empty statement", () => {
    // calls/outliers wrap the query in `` `%s` `` (calls.go:52), so a populated
    // statement renders bare with its runs collapsed.
    expect(legacyInspectBacktickStmt("SELECT\n  1")).toBe("SELECT 1");
  });
  it("renders an empty/null statement as the two literal backticks", () => {
    expect(legacyInspectBacktickStmt("")).toBe("``");
    expect(legacyInspectBacktickStmt(null)).toBe("``");
    expect(legacyInspectBacktickStmt(undefined)).toBe("``");
  });
});

describe("legacyVacuumStatsSpec rowcount projection", () => {
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
    // `to_char(reltuples, '9G999G999G999')` right-justifies in a fixed width, so a
    // -1 reltuples comes back space-padded. Go's `strings.Replace(..., 1)` rewrites
    // only the first `-1` substring; the projection must match byte-for-byte.
    const cells = legacyVacuumStatsSpec.project(row("           -1"), cfg);
    expect(cells[5]).toBe("           No stats");
  });

  it("leaves a real formatted count untouched", () => {
    const cells = legacyVacuumStatsSpec.project(row("    1,234,567"), cfg);
    expect(cells[5]).toBe("    1,234,567");
  });
});
