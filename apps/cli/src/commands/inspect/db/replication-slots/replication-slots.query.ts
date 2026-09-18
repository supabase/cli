import { inspectBool, inspectText, type InspectQuerySpec } from "../inspect-query.ts";

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

/** `inspect db replication-slots` — replication slot status. */
export const replicationSlotsSpec: InspectQuerySpec = {
  name: "replication-slots",
  sql: SQL,
  params: () => [],
  headers: ["Name", "Active", "State", "Replication Client Address", "Replication Lag GB"],
  project: (row) => [
    inspectText(row["slot_name"]),
    inspectBool(row["active"]),
    inspectText(row["state"]),
    inspectText(row["replication_client_address"]),
    inspectText(row["replication_lag_gb"]),
  ],
};
