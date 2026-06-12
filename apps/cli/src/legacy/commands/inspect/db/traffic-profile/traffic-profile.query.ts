import {
  legacyInspectFloat1,
  legacyInspectInt,
  legacyInspectText,
  type LegacyInspectQuerySpec,
} from "../legacy-inspect-query.ts";

// Verbatim from `apps/cli-go/internal/inspect/traffic_profile/traffic_profile.sql`.
const SQL = ` -- Query adapted from Crunchy Data blog: "Is Postgres Read Heavy or Write Heavy? (And Why You Should Care)" by David Christensen
WITH
ratio_target AS (SELECT 5 AS ratio),
table_list AS (SELECT
 s.schemaname,
 s.relname AS table_name,
 si.heap_blks_read + si.idx_blks_read AS blocks_read,
s.n_tup_ins + s.n_tup_upd + s.n_tup_del AS write_tuples,
relpages * (s.n_tup_ins + s.n_tup_upd + s.n_tup_del ) / (case when reltuples = 0 then 1 else reltuples end) as blocks_write
FROM
 pg_stat_user_tables AS s
JOIN pg_statio_user_tables AS si ON s.relid = si.relid
JOIN pg_class c ON c.oid = s.relid
WHERE
(s.n_tup_ins + s.n_tup_upd + s.n_tup_del) > 0
AND
 (si.heap_blks_read + si.idx_blks_read) > 0
 )
SELECT
  schemaname,
  table_name,
  blocks_read,
  write_tuples,
  blocks_write,
  CASE
    WHEN blocks_read = 0 and blocks_write = 0 THEN
      'No Activity'
    WHEN blocks_write * ratio > blocks_read THEN
      CASE
        WHEN blocks_read = 0 THEN 'Write-Only'
        ELSE
          ROUND(blocks_write :: numeric / blocks_read :: numeric, 1)::text || ':1 (Write-Heavy)'
      END
    WHEN blocks_read > blocks_write * ratio THEN
      CASE
        WHEN blocks_write = 0 THEN 'Read-Only'
        ELSE
          '1:' || ROUND(blocks_read::numeric / blocks_write :: numeric, 1)::text || ' (Read-Heavy)'
      END
    ELSE
      '1:1 (Balanced)'
  END AS activity_ratio
FROM table_list, ratio_target
ORDER BY
 (blocks_read + blocks_write) DESC`;

/**
 * `inspect db traffic-profile` — read/write activity ratio per table.
 * Port of `apps/cli-go/internal/inspect/traffic_profile/traffic_profile.go`. The
 * `blocks_write` column is formatted with one decimal place (`%.1f`).
 */
export const legacyTrafficProfileSpec: LegacyInspectQuerySpec = {
  name: "traffic-profile",
  sql: SQL,
  params: () => [],
  headers: ["Schema", "Table", "Blocks Read", "Write Tuples", "Blocks Write", "Activity Ratio"],
  project: (row) => [
    legacyInspectText(row["schemaname"]),
    legacyInspectText(row["table_name"]),
    legacyInspectInt(row["blocks_read"]),
    legacyInspectInt(row["write_tuples"]),
    legacyInspectFloat1(row["blocks_write"]),
    legacyInspectText(row["activity_ratio"]),
  ],
};
