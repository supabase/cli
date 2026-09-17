import type { LegacyInspectReportSpec } from "../legacy-inspect-report.ts";
import type { Report, ReportSeverity } from "../../../../output/report.types.ts";

const SQL = `-- Indexes whose sort order may no longer match the current collation library.
--
-- Two independent sources of drift, unioned:
--
--   libc — the database default collation. Postgres records the glibc version
--          the database was created with (pg_database.datcollversion) and can
--          report the version the OS provides now.
--
--   ICU  — an explicitly named ICU collation, e.g.
--            CREATE INDEX ON t (title COLLATE "en-US-x-icu");
--          Each named collation carries its own recorded version
--          (pg_collation.collversion), compared against the live ICU library.
--
-- A column's attcollation points at exactly one pg_collation row, so an index
-- appears in at most one branch. When nothing has drifted both branches are
-- empty and the report renders its healthy state.
--
-- Only btree indexes are considered: sort order is what a btree encodes, so
-- hash/GIN/GiST/BRIN indexes are unaffected by a collation change.
WITH db_row AS MATERIALIZED (
  -- MATERIALIZED pins evaluation order: pg_database_collation_actual_version()
  -- is only called for a database that actually records a version (a C/POSIX
  -- database records none).
  SELECT oid, datcollversion
  FROM pg_database
  WHERE datname = current_database()
    AND datcollversion IS NOT NULL
),
db_drift AS MATERIALIZED (
  SELECT
    datcollversion AS stored_version,
    pg_database_collation_actual_version(oid) AS current_version
  FROM db_row
),
default_collation AS (
  SELECT oid
  FROM pg_collation
  WHERE collname = 'default'
    AND collnamespace = 'pg_catalog'::regnamespace
),
libc_affected AS (
  SELECT
    FORMAT('%I.%I', n.nspname, i.relname) AS name,
    FORMAT('%I.%I', n.nspname, t.relname) AS table_name,
    STRING_AGG(a.attname, ', ' ORDER BY k.ord) AS columns,
    'default'::text AS collation_name,
    d.stored_version,
    d.current_version,
    ix.indisprimary AS is_primary,
    ix.indisunique AS is_unique,
    pg_relation_size(i.oid) AS size_bytes
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_am am ON am.oid = i.relam
  -- indkey holds 0 for expression columns, which have no pg_attribute row.
  JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
    ON k.attnum <> 0
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
  CROSS JOIN db_drift d
  WHERE am.amname = 'btree'
    AND a.attcollation = (SELECT oid FROM default_collation)
    AND d.stored_version IS DISTINCT FROM d.current_version
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    AND t.relkind IN ('r', 'p', 'm')
  GROUP BY n.nspname, t.relname, i.relname, i.oid,
           d.stored_version, d.current_version,
           ix.indisprimary, ix.indisunique
),
icu_affected AS (
  SELECT
    FORMAT('%I.%I', n.nspname, i.relname) AS name,
    FORMAT('%I.%I', n.nspname, t.relname) AS table_name,
    STRING_AGG(a.attname, ', ' ORDER BY k.ord) AS columns,
    -- Schema-qualified: the generated ALTER COLLATION must target the right
    -- object regardless of search_path.
    FORMAT('%I.%I', cn.nspname, c.collname) AS collation_name,
    c.collversion AS stored_version,
    pg_collation_actual_version(c.oid) AS current_version,
    ix.indisprimary AS is_primary,
    ix.indisunique AS is_unique,
    pg_relation_size(i.oid) AS size_bytes
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_am am ON am.oid = i.relam
  JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
    ON k.attnum <> 0
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
  JOIN pg_collation c ON c.oid = a.attcollation
  JOIN pg_namespace cn ON cn.oid = c.collnamespace
  WHERE am.amname = 'btree'
    AND c.collprovider = 'i'
    AND c.collversion IS NOT NULL
    AND c.collversion IS DISTINCT FROM pg_collation_actual_version(c.oid)
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    AND t.relkind IN ('r', 'p', 'm')
  GROUP BY n.nspname, t.relname, i.relname, i.oid,
           cn.nspname, c.collname, c.collversion, c.oid,
           ix.indisprimary, ix.indisunique
),
all_affected AS (
  SELECT * FROM libc_affected
  UNION ALL
  SELECT * FROM icu_affected
)
SELECT
  current_database() AS database,
  name,
  table_name AS "table",
  columns,
  collation_name AS collation,
  stored_version,
  current_version,
  CASE
    WHEN is_primary THEN 'PRIMARY KEY'
    WHEN is_unique THEN 'UNIQUE'
    ELSE ''
  END AS key_type,
  pg_size_pretty(size_bytes) AS size
FROM all_affected
-- Constraint-backing indexes first: a wrong sort order there can let
-- duplicate rows past a unique check, not merely return wrong results.
ORDER BY is_primary DESC, is_unique DESC, size_bytes DESC`;

// ---------------------------------------------------------------------------
// Pure report construction — exported for unit tests.
// ---------------------------------------------------------------------------

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
export function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function amcheckStatements(rows: ReadonlyArray<DriftRow>): string[] {
  return rows.map(
    (r) =>
      `SELECT bt_index_check('${r.name}'::regclass, heapallindexed => true);` +
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
  // Distinct named collations, first-seen order. Already schema-qualified and
  // quoted where needed by the SQL's FORMAT('%I.%I', ...).
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
          text: "No collation version drift detected. Indexes match the current system sorting rules. Re-run this check after a PostgreSQL upgrade or instance migration.",
        },
      ],
    };
  }

  const rows = rawRows.map(toDriftRow);
  const keyRows = rows.filter((r) => r.key_type !== "");
  const severity: ReportSeverity = keyRows.length > 0 ? "critical" : "warn";

  const libcDrift = rows.find((r) => r.collation === "default");
  const namedCollations = [...new Set(rows.map((r) => r.collation))].filter((c) => c !== "default");

  const environment: Array<{ key: string; value: string }> = [
    { key: "Database", value: rows[0]?.database ?? "" },
    { key: "Affected indexes", value: String(rows.length) },
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
    environment.push({ key: "Drifted ICU collations", value: namedCollations.join(", ") });
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
            title: "Confirm which indexes are actually mis-ordered",
            body: "amcheck raises an error for a mis-ordered index and returns silently for a healthy one. Check keys and unique indexes first.",
            sql: ["CREATE EXTENSION IF NOT EXISTS amcheck;", ...amcheckStatements(rows)],
          },
          {
            title: "Rebuild the affected indexes",
            body: "Rebuild anything that failed step 1 — or all of them, which is safe if you would rather not check individually. CONCURRENTLY keeps the application online during the rebuild.",
            sql: reindexStatements(rows),
          },
          {
            title: "Record the new collation version — only after every rebuild has finished",
            body: "Refreshing first hides the problem without fixing it: it updates a label and silences the warning while leaving the indexes mis-ordered.",
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
export const legacyCollationDriftSpec: LegacyInspectReportSpec = {
  name: "collation-drift",
  sql: SQL,
  params: () => [],
  report: (rows) => buildCollationDriftReport(rows),
};
