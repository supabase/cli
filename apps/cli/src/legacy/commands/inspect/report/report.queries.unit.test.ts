import { describe, expect, it } from "vitest";

import { LEGACY_INTERNAL_SCHEMAS, legacyLikeEscapeSchema } from "../db/legacy-inspect-schemas.ts";
import {
  LEGACY_REPORT_QUERIES,
  legacyReportIgnoreSchemas,
  legacyWrapReportQuery,
} from "./report.queries.ts";

describe("legacyWrapReportQuery", () => {
  // Ports apps/cli-go/internal/inspect/report_test.go::TestWrapQuery.
  it("wraps a query in CSV COPY with no placeholders", () => {
    expect(legacyWrapReportQuery("SELECT 1")).toBe("COPY (SELECT 1) TO STDOUT WITH CSV HEADER");
  });

  it("replaces the $1 placeholder value", () => {
    const ignoreSchemas = legacyReportIgnoreSchemas();
    expect(legacyWrapReportQuery("SELECT 'a' LIKE ANY($1)", ignoreSchemas)).toBe(
      `COPY (SELECT 'a' LIKE ANY(${ignoreSchemas})) TO STDOUT WITH CSV HEADER`,
    );
  });

  it("replaces $1 and $2 in order", () => {
    expect(legacyWrapReportQuery("SELECT $1, $2", "'schemas'", "'postgres'")).toBe(
      "COPY (SELECT 'schemas', 'postgres') TO STDOUT WITH CSV HEADER",
    );
  });

  it("replaces every occurrence of $1 (ReplaceAll, not first-only)", () => {
    expect(legacyWrapReportQuery("WHERE a LIKE ANY($1) AND b LIKE ANY($1)", "X")).toBe(
      "COPY (WHERE a LIKE ANY(X) AND b LIKE ANY(X)) TO STDOUT WITH CSV HEADER",
    );
  });
});

describe("legacyReportIgnoreSchemas", () => {
  it("renders the internal schemas as an escaped text[] literal", () => {
    const expected = `'{${legacyLikeEscapeSchema(LEGACY_INTERNAL_SCHEMAS).join(",")}}'::text[]`;
    expect(legacyReportIgnoreSchemas()).toBe(expected);
    // The wildcard schema patterns are LIKE-escaped (underscore → \_, * → %).
    expect(legacyReportIgnoreSchemas()).toContain("pg\\_%");
  });
});

describe("LEGACY_REPORT_QUERIES", () => {
  it("has the 14 underscore CSV basenames Go embeds", () => {
    expect(LEGACY_REPORT_QUERIES.map((q) => q.fileName)).toEqual([
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
      "vacuum_stats",
    ]);
  });

  it("carries non-empty SQL for every query", () => {
    for (const query of LEGACY_REPORT_QUERIES) {
      expect(query.sql.length).toBeGreaterThan(0);
    }
  });

  it("keeps the standalone unused_indexes query (its own columns, not index-stats)", () => {
    const unused = LEGACY_REPORT_QUERIES.find((q) => q.fileName === "unused_indexes");
    expect(unused?.sql).toContain("idx_scan as index_scans");
    expect(unused?.sql).toContain("$1");
  });
});
