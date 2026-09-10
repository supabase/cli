import { describe, expect, it } from "vitest";

import { INTERNAL_SCHEMAS, likeEscapeSchema } from "../db/inspect-schemas.ts";
import { REPORT_QUERIES, reportIgnoreSchemas, wrapReportQuery } from "./report.queries.ts";

describe("wrapReportQuery", () => {
  it("wraps a query in CSV COPY with no placeholders", () => {
    expect(wrapReportQuery("SELECT 1")).toBe("COPY (SELECT 1) TO STDOUT WITH CSV HEADER");
  });

  it("replaces the $1 placeholder value", () => {
    const ignoreSchemas = reportIgnoreSchemas();
    expect(wrapReportQuery("SELECT 'a' LIKE ANY($1)", ignoreSchemas)).toBe(
      `COPY (SELECT 'a' LIKE ANY(${ignoreSchemas})) TO STDOUT WITH CSV HEADER`,
    );
  });

  it("replaces $1 and $2 in order", () => {
    expect(wrapReportQuery("SELECT $1, $2", "'schemas'", "'postgres'")).toBe(
      "COPY (SELECT 'schemas', 'postgres') TO STDOUT WITH CSV HEADER",
    );
  });

  it("replaces every occurrence of $1 (ReplaceAll, not first-only)", () => {
    expect(wrapReportQuery("WHERE a LIKE ANY($1) AND b LIKE ANY($1)", "X")).toBe(
      "COPY (WHERE a LIKE ANY(X) AND b LIKE ANY(X)) TO STDOUT WITH CSV HEADER",
    );
  });
});

describe("reportIgnoreSchemas", () => {
  it("renders the internal schemas as an escaped text[] literal", () => {
    const expected = `'{${likeEscapeSchema(INTERNAL_SCHEMAS).join(",")}}'::text[]`;
    expect(reportIgnoreSchemas()).toBe(expected);
    // The wildcard schema patterns are LIKE-escaped (underscore → \_, * → %).
    expect(reportIgnoreSchemas()).toContain("pg\\_%");
  });
});

describe("REPORT_QUERIES", () => {
  it("has the 15 underscore CSV basenames Go embeds", () => {
    expect(REPORT_QUERIES.map((q) => q.fileName)).toEqual([
      "bloat",
      "blocking",
      "calls",
      "db_stats",
      "index_stats",
      "locks",
      "long_running_queries",
      "outliers",
      "replication_slots",
      "role_stats",
      "table_stats",
      "traffic_profile",
      "unused_indexes",
      "toast_sizes",
      "vacuum_stats",
    ]);
  });

  it("carries non-empty SQL for every query", () => {
    for (const query of REPORT_QUERIES) {
      expect(query.sql.length).toBeGreaterThan(0);
    }
  });

  it("keeps the standalone unused_indexes query (its own columns, not index-stats)", () => {
    const unused = REPORT_QUERIES.find((q) => q.fileName === "unused_indexes");
    expect(unused?.sql).toContain("idx_scan as index_scans");
    expect(unused?.sql).toContain("$1");
  });
});
