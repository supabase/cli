import { describe, expect, it } from "vitest";

import {
  amcheckStatements,
  buildCollationDriftReport,
  refreshStatements,
  reindexStatements,
} from "./collation-drift.query.ts";
import type { ReportStepsBlock, ReportTableBlock } from "../../../../output/report.types.ts";

const PG17 = 170000;

const libcRow = {
  database: "postgres",
  name: "public.t_key",
  table: "public.events",
  columns: "title",
  collation: "default",
  stored_version: "2.39",
  current_version: "2.40",
  key_type: "UNIQUE",
  size: "148 MB",
};

const icuRow = {
  database: "postgres",
  name: "public.demo_title_idx",
  table: "public.collation_drift_demo",
  columns: "title",
  collation: "public.test_stale_icu",
  stored_version: "153.14",
  current_version: "153.121",
  key_type: "",
  size: "8192 bytes",
};

function stepsBlock(report: ReturnType<typeof buildCollationDriftReport>): ReportStepsBlock {
  const block = report.blocks.find((b) => b.kind === "steps");
  if (block === undefined || block.kind !== "steps") throw new Error("no steps block");
  return block;
}

describe("buildCollationDriftReport", () => {
  it("renders the healthy state as an ok callout with no remediation", () => {
    const report = buildCollationDriftReport([], PG17);

    expect(report.severity).toBe("ok");
    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0]).toMatchObject({
      kind: "callout",
      severity: "ok",
    });
  });

  it("is critical when a key or unique index is affected, warn otherwise", () => {
    expect(buildCollationDriftReport([libcRow], PG17).severity).toBe("critical");
    expect(buildCollationDriftReport([icuRow], PG17).severity).toBe("warn");
  });

  it("includes environment, callout, table, and steps blocks when drift exists", () => {
    const kinds = buildCollationDriftReport([libcRow, icuRow], PG17).blocks.map((b) => b.kind);
    expect(kinds).toEqual(["keyValue", "callout", "table", "steps"]);
  });

  it("keeps the row order the SQL produced (keys first)", () => {
    const report = buildCollationDriftReport([libcRow, icuRow], PG17);
    const table = report.blocks.find((b) => b.kind === "table") as ReportTableBlock;
    expect(table.rows[0]?.cells[0]).toBe("public.t_key");
    expect(table.rows[0]?.severity).toBe("critical");
    expect(table.rows[1]?.severity).toBe("warn");
  });

  it("orders the workflow verify → rebuild → refresh", () => {
    const steps = stepsBlock(buildCollationDriftReport([libcRow], PG17)).steps;
    expect(steps.map((s) => s.title)).toEqual([
      "Diagnose the listed indexes (optional)",
      "Rebuild every listed index",
      "Record the new collation version — only after every rebuild has finished",
    ]);
  });

  it("lists an index once in the workflow when several of its collations drifted", () => {
    const multi = [
      { ...libcRow, name: "public.m_ab", key_type: "", columns: "a" },
      { ...icuRow, name: "public.m_ab", columns: "b" },
    ];
    const report = buildCollationDriftReport(multi, PG17);
    const [, rebuild, refresh] = stepsBlock(report).steps;

    expect(report.blocks[0]).toMatchObject({
      kind: "keyValue",
      entries: expect.arrayContaining([{ key: "Affected indexes", value: "1" }]),
    });
    expect(rebuild?.sql).toEqual(["REINDEX INDEX CONCURRENTLY public.m_ab;"]);
    expect(refresh?.sql).toEqual([
      'ALTER DATABASE "postgres" REFRESH COLLATION VERSION;',
      "ALTER COLLATION public.test_stale_icu REFRESH VERSION;",
    ]);
  });

  it("degrades null cells instead of throwing", () => {
    const report = buildCollationDriftReport([{ ...libcRow, current_version: null }], PG17);
    const table = report.blocks.find((b) => b.kind === "table") as ReportTableBlock;
    expect(table.rows[0]?.cells[5]).toBe("");
  });
});

describe("generated statements", () => {
  it("keeps the amcheck literal intact for quote-bearing index names", () => {
    const evil = { ...icuRow, name: `public."evil'; DROP TABLE users; --"` };
    const statements = amcheckStatements([evil] as never);
    const statement = statements[0] ?? "";
    expect(statement).toContain(`'public."evil''; DROP TABLE users; --"'::regclass`);
    expect(statement.split("'").length % 2).toBe(1); // even quote count = literal broke
  });

  it("marks key-backing indexes in the amcheck list", () => {
    const [keyed, plain] = amcheckStatements([libcRow, icuRow] as never);
    expect(keyed).toContain("-- unique");
    expect(plain).not.toContain("--");
  });

  it("reindexes by the already-qualified index name", () => {
    expect(reindexStatements([icuRow] as never)).toEqual([
      "REINDEX INDEX CONCURRENTLY public.demo_title_idx;",
    ]);
  });

  it("emits ALTER DATABASE only for default-collation drift", () => {
    expect(refreshStatements([icuRow] as never)).toEqual([
      "ALTER COLLATION public.test_stale_icu REFRESH VERSION;",
    ]);
    expect(refreshStatements([libcRow] as never)).toEqual([
      'ALTER DATABASE "postgres" REFRESH COLLATION VERSION;',
    ]);
  });

  it("rebuilds exclusion-constraint indexes without CONCURRENTLY", () => {
    expect(reindexStatements([{ ...icuRow, key_type: "EXCLUSION" }] as never)).toEqual([
      "REINDEX INDEX public.demo_title_idx;  -- exclusion constraint: CONCURRENTLY is unsupported, blocks writes while it runs",
    ]);
  });

  it("deduplicates a collation shared by several indexes", () => {
    const second = { ...icuRow, name: "public.demo_title_uniq" };
    const statements = refreshStatements([icuRow, second] as never);
    expect(statements).toHaveLength(1);
  });
});
