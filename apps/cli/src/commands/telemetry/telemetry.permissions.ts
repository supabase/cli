import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `telemetry` command group. */
export const telemetryPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["telemetry disable", "telemetry enable", "telemetry status"],
};
