import { describe, expect, it } from "vitest";

import { buildCollationDriftReport } from "./collation-drift.query.ts";
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

function stepSql(rows: ReadonlyArray<Record<string, unknown>>, step: number) {
  return stepsBlock(buildCollationDriftReport(rows, PG17)).steps[step]?.sql ?? [];
}

describe("generated statements", () => {
  it("escapes quotes and backslashes in the amcheck literal", () => {
    const crafted = { ...icuRow, name: `public."x\\'::text::regclass) WHERE false;SELECT 1;--"` };
    expect(stepSql([crafted], 0)[1]).toBe(
      `SELECT bt_index_check(E'public."x\\\\\\'::text::regclass) WHERE false;SELECT 1;--"'::regclass, heapallindexed => true);`,
    );
  });

  it("marks key-backing indexes in the amcheck list", () => {
    const [, keyed, plain] = stepSql([libcRow, icuRow], 0);
    expect(keyed).toContain("-- unique");
    expect(plain).not.toContain("--");
  });

  it("rebuilds concurrently, except exclusion-constraint indexes", () => {
    const exclusion = { ...icuRow, name: "public.demo_excl", key_type: "EXCLUSION" };
    expect(stepSql([icuRow, exclusion], 1)).toEqual([
      "REINDEX INDEX CONCURRENTLY public.demo_title_idx;",
      "REINDEX INDEX public.demo_excl;  -- exclusion constraint: CONCURRENTLY is unsupported, blocks writes while it runs",
    ]);
  });

  it("refreshes the database only for default-collation drift, and each collation once", () => {
    const second = { ...icuRow, name: "public.demo_title_uniq" };
    expect(stepSql([icuRow, second], 2)).toEqual([
      "ALTER COLLATION public.test_stale_icu REFRESH VERSION;",
    ]);
    expect(stepSql([libcRow], 2)).toEqual(['ALTER DATABASE "postgres" REFRESH COLLATION VERSION;']);
  });
});
