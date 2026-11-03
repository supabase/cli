import type { InspectReportSpec } from "../inspect-report.ts";
import type { Report, ReportSeverity } from "../../../../output/report.types.ts";

// Detects btree drift for the database default collation (PG15+) and named collations.
// Other access methods are out of scope; amcheck verifies only btree.
// pg_database records the default collation's version from PG15; PG15 itself only reports
// the current version through pg_database_collation_actual_version().
function collationDriftSql(serverVersionNum: number): string {
  const [dbStored, dbCurrent] =
    serverVersionNum >= 150000
      ? [
          "(SELECT datcollversion FROM pg_database WHERE datname = current_database())",
          "(SELECT pg_database_collation_actual_version(oid) FROM pg_database WHERE datname = current_database())",
        ]
      : ["NULL::text", "NULL::text"];
  return `WITH key_collations AS (
  SELECT DISTINCT
    ix.indexrelid,
    ix.indrelid,
    k.colloid,
    ix.indisprimary AS is_primary,
    ix.indisunique AS is_unique
  FROM pg_index ix
  -- indkey holds 0 for expression columns, which have no pg_attribute row.
  JOIN LATERAL unnest(ix.indkey, ix.indcollation) AS k(attnum, colloid) ON k.attnum <> 0
  WHERE k.colloid <> 0
),
drifted AS (
  SELECT
    kc.*,
    CASE WHEN kc.colloid = 'pg_catalog.default'::regcollation
      THEN ${dbStored}
      ELSE c.collversion
    END AS stored_version,
    CASE WHEN kc.colloid = 'pg_catalog.default'::regcollation
      THEN ${dbCurrent}
      ELSE pg_collation_actual_version(kc.colloid)
    END AS current_version,
    CASE WHEN kc.colloid = 'pg_catalog.default'::regcollation
      THEN 'default'
      -- Schema-qualified: the generated ALTER COLLATION must not depend on search_path.
      ELSE FORMAT('%I.%I', cn.nspname, c.collname)
    END AS collation_name
  FROM key_collations kc
  JOIN pg_collation c ON c.oid = kc.colloid
  JOIN pg_namespace cn ON cn.oid = c.collnamespace
)
SELECT
  current_database() AS database,
  FORMAT('%I.%I', n.nspname, i.relname) AS name,
  FORMAT('%I.%I', n.nspname, t.relname) AS "table",
  (
    SELECT STRING_AGG(a.attname, ', ' ORDER BY k.ord)
    FROM pg_index ix
    JOIN LATERAL unnest(ix.indkey, ix.indcollation) WITH ORDINALITY AS k(attnum, colloid, ord) ON true
    JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
    WHERE ix.indexrelid = dr.indexrelid AND k.colloid = dr.colloid
  ) AS columns,
  dr.collation_name AS collation,
  dr.stored_version,
  dr.current_version,
  CASE
    WHEN dr.is_primary THEN 'PRIMARY KEY'
    WHEN dr.is_unique THEN 'UNIQUE'
    ELSE ''
  END AS key_type,
  pg_size_pretty(pg_relation_size(i.oid)) AS size
FROM drifted dr
JOIN pg_class i ON i.oid = dr.indexrelid
JOIN pg_class t ON t.oid = dr.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_am am ON am.oid = i.relam
WHERE am.amname = 'btree'
  -- Partitioned indexes ('I') hold no data; each partition's index is listed instead.
  AND i.relkind = 'i'
  AND t.relkind IN ('r', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  AND dr.stored_version IS NOT NULL
  AND dr.stored_version IS DISTINCT FROM dr.current_version
-- Constraint-backing indexes first: a wrong sort order there can let
-- duplicate rows past a unique check, not merely return wrong results.
ORDER BY dr.is_primary DESC, dr.is_unique DESC, pg_relation_size(i.oid) DESC, name`;
}

interface DriftRow {
  readonly database: string;
  readonly name: string;
  readonly table: string;
  readonly columns: string;
  readonly collation: string;
  readonly stored_version: string;
  readonly current_version: string;
  readonly key_type: string;
  readonly size: string;
}

function toDriftRow(row: Record<string, unknown>): DriftRow {
  const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return {
    database: text(row["database"]),
    name: text(row["name"]),
    table: text(row["table"]),
    columns: text(row["columns"]),
    collation: text(row["collation"]),
    stored_version: text(row["stored_version"]),
    current_version: text(row["current_version"]),
    key_type: text(row["key_type"]),
    size: text(row["size"]),
  };
}

/** Double-quotes an identifier, escaping embedded quotes. */
function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Single-quotes a value as a SQL string literal, escaping embedded quotes. */
function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function amcheckStatements(rows: ReadonlyArray<DriftRow>): string[] {
  return rows.map(
    (r) =>
      `SELECT bt_index_check(${quoteLiteral(r.name)}::regclass, heapallindexed => true);` +
      (r.key_type === "" ? "" : `  -- ${r.key_type.toLowerCase()}`),
  );
}

export function reindexStatements(rows: ReadonlyArray<DriftRow>): string[] {
  return rows.map((r) => `REINDEX INDEX CONCURRENTLY ${r.name};`);
}

export function refreshStatements(rows: ReadonlyArray<DriftRow>): string[] {
  const out: string[] = [];
  if (rows.some((r) => r.collation === "default")) {
    const database = rows[0]?.database ?? "postgres";
    out.push(`ALTER DATABASE ${quoteIdent(database)} REFRESH COLLATION VERSION;`);
  }
  // Already quoted by the SQL's FORMAT('%I.%I', ...).
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.collation === "default" || seen.has(r.collation)) continue;
    seen.add(r.collation);
    out.push(`ALTER COLLATION ${r.collation} REFRESH VERSION;`);
  }
  return out;
}

export function buildCollationDriftReport(rawRows: ReadonlyArray<Record<string, unknown>>): Report {
  if (rawRows.length === 0) {
    return {
      command: "collation-drift",
      severity: "ok",
      blocks: [
        {
          kind: "callout",
          severity: "ok",
          text: "No recorded collation version mismatch on btree index key columns. This compares version labels and does not verify index ordering or expression indexes. Re-run this check after a PostgreSQL upgrade or instance migration.",
        },
      ],
    };
  }

  const rows = rawRows.map(toDriftRow);
  // An index with key columns on several drifted collations has one row per collation.
  const indexes = [...new Map(rows.map((r) => [r.name, r])).values()];
  const keyRows = indexes.filter((r) => r.key_type !== "");
  const severity: ReportSeverity = keyRows.length > 0 ? "critical" : "warn";

  const libcDrift = rows.find((r) => r.collation === "default");
  const namedCollations = [...new Set(rows.map((r) => r.collation))].filter((c) => c !== "default");

  const environment: Array<{ key: string; value: string }> = [
    { key: "Database", value: rows[0]?.database ?? "" },
    { key: "Affected indexes", value: String(indexes.length) },
  ];
  if (keyRows.length > 0) {
    environment.push({
      key: "Keys / unique",
      value: `${keyRows.length} (a wrong sort order here can admit duplicate rows)`,
    });
  }
  if (libcDrift !== undefined) {
    environment.push({
      key: "Default collation",
      value: `${libcDrift.stored_version} (recorded)  →  ${libcDrift.current_version} (current)`,
    });
  }
  if (namedCollations.length > 0) {
    environment.push({ key: "Drifted collations", value: namedCollations.join(", ") });
  }

  return {
    command: "collation-drift",
    severity,
    blocks: [
      { kind: "keyValue", entries: environment },
      {
        kind: "callout",
        severity,
        text: "These indexes were built under different sorting rules than the system now provides. Postgres reports no error for this: queries may quietly return missing rows, sort incorrectly, or let duplicates past a unique constraint. Rows below are candidates and running amcheck would confirm which ones are actually mis-ordered.",
      },
      {
        kind: "table",
        columns: [
          { title: "Name" },
          { title: "Table" },
          { title: "Columns" },
          { title: "Collation" },
          { title: "Stored version" },
          { title: "Current version" },
          { title: "Key" },
          { title: "Size" },
        ],
        rows: rows.map((r) => ({
          cells: [
            r.name,
            r.table,
            r.columns,
            r.collation,
            r.stored_version,
            r.current_version,
            r.key_type,
            r.size,
          ],
          severity: r.key_type === "" ? ("warn" as const) : ("critical" as const),
        })),
      },
      {
        kind: "steps",
        steps: [
          {
            title: "Diagnose the listed indexes (optional)",
            body: "amcheck raises an error when it finds a mis-ordered index. A clean result does not prove the index is safe, so it does not replace step 2.",
            sql: ["CREATE EXTENSION IF NOT EXISTS amcheck;", ...amcheckStatements(indexes)],
          },
          {
            title: "Rebuild every listed index",
            body: "Run each statement on its own, outside a transaction block. CONCURRENTLY keeps the application online during the rebuild.",
            sql: reindexStatements(indexes),
          },
          {
            title: "Record the new collation version — only after every rebuild has finished",
            body: "Refreshing first hides the problem without fixing it: it updates a label and silences the warning while leaving the indexes mis-ordered. The list above covers btree key columns only; also rebuild expression indexes and any other index or constraint that uses these collations before refreshing.",
            sql: refreshStatements(rows),
          },
        ],
      },
    ],
  };
}

/**
 * `inspect db collation-drift` — btree indexes on text columns whose collation
 * version no longer matches the version the operating system provides, with
 * the verify → rebuild → refresh workflow rendered as part of the output.
 *
 * Unlike the sibling commands this does NOT filter the internal Supabase
 * schemas (`auth`, `storage`, …): those hold user data, and a mis-ordered
 * index on `auth.users` is exactly as damaging as one in `public`.
 */
export const collationDriftSpec: InspectReportSpec = {
  name: "collation-drift",
  sql: collationDriftSql,
  report: buildCollationDriftReport,
};
