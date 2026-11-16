import { describe, expect, it } from "vitest";

import { renderGlamourTable } from "./glamour-table.ts";
import { renderReportText } from "./report-render-text.ts";

describe("renderReportText", () => {
  it("renders aligned pairs, a wrapped callout, a severity table and numbered SQL steps", () => {
    const out = renderReportText({
      command: "demo",
      severity: "warn",
      blocks: [
        {
          kind: "keyValue",
          entries: [
            { key: "Database", value: "postgres" },
            { key: "Affected indexes", value: "2" },
          ],
        },
        {
          kind: "callout",
          severity: "warn",
          text: "These indexes were built under different sorting rules than the system now provides today.",
        },
        {
          kind: "table",
          columns: [{ title: "Name" }],
          rows: [{ cells: ["a_key"], severity: "critical" }, { cells: ["b_idx"] }],
        },
        {
          kind: "steps",
          steps: [
            { title: "Rebuild", body: "One at a time.", sql: ["REINDEX INDEX a_key;"] },
            { title: "Refresh" },
          ],
        },
      ],
    });

    expect(out).toBe(
      [
        "",
        "  Database         : postgres",
        "  Affected indexes : 2",
        "",
        "  ⚠  These indexes were built under different sorting rules than the system",
        "     now provides today.",
        "",
        renderGlamourTable(
          ["", "Name"],
          [
            ["✗", "a_key"],
            ["", "b_idx"],
          ],
        ),
        "  1. Rebuild",
        "     One at a time.",
        "",
        "       REINDEX INDEX a_key;",
        "",
        "  2. Refresh",
        "",
        "",
      ].join("\n"),
    );
  });
});
