import { describe, expect, it } from "vitest";

import { type LegacyCsvTableProvider, legacyParseReportCsv } from "./report.csvq.ts";
import {
  type LegacyInspectRule,
  legacyBuildRuleSummaryRows,
  legacyEvaluateInspectRule,
} from "./report.rules.ts";

function provider(tables: Record<string, string>): LegacyCsvTableProvider {
  return (name) => (name in tables ? legacyParseReportCsv(tables[name]!) : undefined);
}

const RULE: LegacyInspectRule = {
  query: "SELECT LISTAGG(stmt, ',') AS match FROM `locks.csv` WHERE granted = 'f'",
  name: "No ungranted locks",
  pass: "✔",
  fail: "There is at least one ungranted lock",
};

describe("legacyEvaluateInspectRule", () => {
  it("passes with a '-' matches cell when no rows match (csvq NULL)", () => {
    const result = legacyEvaluateInspectRule(
      RULE,
      provider({ "locks.csv": "stmt,granted\nA,t\n" }),
    );
    expect(result).toEqual({ name: RULE.name, status: "✔", matches: "-" });
  });

  it("fails with the matched list when rows match", () => {
    const result = legacyEvaluateInspectRule(
      RULE,
      provider({ "locks.csv": "stmt,granted\nA,f\nB,f\n" }),
    );
    expect(result).toEqual({ name: RULE.name, status: RULE.fail, matches: "A,B" });
  });

  it("treats a valid empty string match as a pass with an empty matches cell", () => {
    // The single matched row's `stmt` is empty, so LISTAGG yields "" (valid, not NULL).
    const result = legacyEvaluateInspectRule(
      RULE,
      provider({ "locks.csv": 'stmt,granted\n"",f\n' }),
    );
    expect(result).toEqual({ name: RULE.name, status: "✔", matches: "" });
  });

  it("surfaces a csvq error as the STATUS cell without throwing", () => {
    const broken: LegacyInspectRule = { ...RULE, query: "SELECT COUNT(*) FROM `missing.csv`" };
    const result = legacyEvaluateInspectRule(broken, provider({}));
    expect(result.matches).toBe("-");
    expect(result.status).toContain("missing.csv");
    expect(result.status).not.toBe(RULE.pass);
    expect(result.status).not.toBe(RULE.fail);
  });

  it("summarizes long match lists by count", () => {
    const result = legacyEvaluateInspectRule(
      RULE,
      provider({ "locks.csv": "stmt,granted\none,f\ntwo,f\nthree,f\nfour,f\nfive,f\n" }),
    );
    expect(result).toEqual({ name: RULE.name, status: RULE.fail, matches: "5 matches" });
  });
});

describe("legacyBuildRuleSummaryRows", () => {
  it("preserves rule order and renders an empty matches cell as two backticks", () => {
    const rows = legacyBuildRuleSummaryRows([
      { name: "First", status: "✔", matches: "-" },
      { name: "Second", status: "fail msg", matches: "" },
    ]);
    expect(rows).toEqual([
      ["First", "✔", "-"],
      ["Second", "fail msg", "``"],
    ]);
  });
});
