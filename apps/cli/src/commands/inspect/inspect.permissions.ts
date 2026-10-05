import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `inspect` command group. */
export const inspectPermissions: PermissionGroup = {
  declared: new Map(),
  pending: [
    "inspect db bloat",
    "inspect db blocking",
    "inspect db cache-hit",
    "inspect db calls",
    "inspect db db-stats",
    "inspect db index-sizes",
    "inspect db index-stats",
    "inspect db index-usage",
    "inspect db locks",
    "inspect db long-running-queries",
    "inspect db outliers",
    "inspect db replication-slots",
    "inspect db role-configs",
    "inspect db role-connections",
    "inspect db role-stats",
    "inspect db seq-scans",
    "inspect db table-index-sizes",
    "inspect db table-record-counts",
    "inspect db table-sizes",
    "inspect db table-stats",
    "inspect db total-index-size",
    "inspect db total-table-sizes",
    "inspect db traffic-profile",
    "inspect db unused-indexes",
    "inspect db vacuum-stats",
    "inspect report",
  ],
};
