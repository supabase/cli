import { describe, expect, it } from "vitest";

import { type CsvTableProvider, parseReportCsv } from "./report.csvq.ts";
import { type InspectRule, buildRuleSummaryRows, evaluateInspectRule } from "./report.rules.ts";

function provider(tables: Record<string, string>): CsvTableProvider {
  return (name) => (name in tables ? parseReportCsv(tables[name]!) : undefined);
}

const RULE: InspectRule = {
  query: "SELECT LISTAGG(stmt, ',') AS match FROM `locks.csv` WHERE granted = 'f'",
  name: "No ungranted locks",
  pass: "✔",
  fail: "There is at least one ungranted lock",
};

describe("evaluateInspectRule", () => {
  it("passes with a '-' matches cell when no rows match (csvq NULL)", () => {
    const result = evaluateInspectRule(RULE, provider({ "locks.csv": "stmt,granted\nA,t\n" }));
    expect(result).toEqual({ name: RULE.name, status: "✔", matches: "-" });
  });

  it("fails with the matched list when rows match", () => {
    const result = evaluateInspectRule(RULE, provider({ "locks.csv": "stmt,granted\nA,f\nB,f\n" }));
    expect(result).toEqual({ name: RULE.name, status: RULE.fail, matches: "A,B" });
  });

  it("treats a valid empty string match as a pass with an empty matches cell", () => {
    // The single matched row's `stmt` is empty, so LISTAGG yields "" (valid, not NULL).
    const result = evaluateInspectRule(RULE, provider({ "locks.csv": 'stmt,granted\n"",f\n' }));
    expect(result).toEqual({ name: RULE.name, status: "✔", matches: "" });
  });

  it("surfaces a csvq error as the STATUS cell without throwing", () => {
    const broken: InspectRule = { ...RULE, query: "SELECT COUNT(*) FROM `missing.csv`" };
    const result = evaluateInspectRule(broken, provider({}));
    expect(result.matches).toBe("-");
    expect(result.status).toContain("missing.csv");
    expect(result.status).not.toBe(RULE.pass);
    expect(result.status).not.toBe(RULE.fail);
  });

  it("summarizes long match lists by count", () => {
    const result = evaluateInspectRule(
      RULE,
      provider({ "locks.csv": "stmt,granted\none,f\ntwo,f\nthree,f\nfour,f\nfive,f\n" }),
    );
    expect(result).toEqual({ name: RULE.name, status: RULE.fail, matches: "5 matches" });
  });
});

describe("buildRuleSummaryRows", () => {
  it("preserves rule order and renders an empty matches cell as two backticks", () => {
    const rows = buildRuleSummaryRows([
      { name: "First", status: "✔", matches: "-" },
      { name: "Second", status: "fail msg", matches: "" },
    ]);
    expect(rows).toEqual([
      ["First", "✔", "-"],
      ["Second", "fail msg", "``"],
    ]);
  });
});
