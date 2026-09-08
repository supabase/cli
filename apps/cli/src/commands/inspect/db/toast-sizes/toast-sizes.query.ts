import {
  inspectFloat1,
  inspectInt,
  inspectPlainText,
  inspectText,
  type InspectQuerySpec,
} from "../inspect-query.ts";
import { INTERNAL_SCHEMAS, likeEscapeSchema } from "../inspect-schemas.ts";

const SQL = `
SELECT
  FORMAT('%I.%I', n.nspname, main.relname)                            AS name,
  pg_size_pretty(pg_total_relation_size(main.oid))                    AS total_size,
  pg_size_pretty(pg_relation_size(main.oid))                          AS heap_size,
  pg_size_pretty(pg_relation_size(main.reltoastrelid))                AS toast_size,
  COALESCE(ts.n_live_tup, 0)                                          AS toast_live_chunks,
  COALESCE(ts.n_dead_tup, 0)                                          AS toast_dead_chunks,
  COALESCE(
    round(100.0 * ts.n_dead_tup / nullif(ts.n_live_tup + ts.n_dead_tup, 0), 1),
    0.0
  )                                                                    AS toast_dead_pct,
  COALESCE(to_char(ts.last_autovacuum, 'YYYY-MM-DD HH24:MI'), '')     AS last_autovacuum,
  COALESCE(to_char(ts.last_vacuum, 'YYYY-MM-DD HH24:MI'), '')         AS last_vacuum
FROM pg_class main
JOIN pg_namespace n ON n.oid = main.relnamespace
LEFT JOIN pg_stat_all_tables ts ON ts.relid = main.reltoastrelid
WHERE main.relkind = 'r'
  AND main.reltoastrelid <> 0
  AND NOT n.nspname LIKE ANY($1)
ORDER BY pg_relation_size(main.reltoastrelid) DESC`;

export const toastSizesSpec: InspectQuerySpec = {
  name: "toast-sizes",
  sql: SQL,
  params: () => [likeEscapeSchema(INTERNAL_SCHEMAS)],
  headers: [
    "Table",
    "Total Size",
    "Heap Size",
    "TOAST Size",
    "TOAST Live Chunks",
    "TOAST Dead Chunks",
    "TOAST Dead %",
    "Last Autovacuum",
    "Last Vacuum",
  ],
  project: (row) => [
    inspectText(row["name"]),
    inspectText(row["total_size"]),
    inspectText(row["heap_size"]),
    inspectText(row["toast_size"]),
    inspectInt(row["toast_live_chunks"]),
    inspectInt(row["toast_dead_chunks"]),
    inspectFloat1(row["toast_dead_pct"]),
    inspectPlainText(row["last_autovacuum"]),
    inspectPlainText(row["last_vacuum"]),
  ],
};
