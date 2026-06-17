import {
  legacyInspectBool,
  legacyInspectText,
  type LegacyInspectQuerySpec,
} from "../legacy-inspect-query.ts";

// Verbatim from `apps/cli-go/internal/inspect/replication_slots/replication_slots.sql`.
const SQL = `SELECT
  s.slot_name,
  s.active,
  COALESCE(r.state, 'N/A') as state,
  CASE WHEN r.client_addr IS NULL
    THEN 'N/A'
    ELSE r.client_addr::text
  END replication_client_address,
  GREATEST(0, ROUND((redo_lsn-restart_lsn)/1024/1024/1024, 2)) as replication_lag_gb
FROM pg_control_checkpoint(), pg_replication_slots s
LEFT JOIN pg_stat_replication r ON (r.pid = s.active_pid)`;

/**
 * `inspect db replication-slots` — replication slot status.
 * Port of `apps/cli-go/internal/inspect/replication_slots/replication_slots.go`.
 */
export const legacyReplicationSlotsSpec: LegacyInspectQuerySpec = {
  name: "replication-slots",
  sql: SQL,
  params: () => [],
  headers: ["Name", "Active", "State", "Replication Client Address", "Replication Lag GB"],
  project: (row) => [
    legacyInspectText(row["slot_name"]),
    legacyInspectBool(row["active"]),
    legacyInspectText(row["state"]),
    legacyInspectText(row["replication_client_address"]),
    legacyInspectText(row["replication_lag_gb"]),
  ],
};
