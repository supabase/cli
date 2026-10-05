import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `postgres-config` command group. */
export const postgresConfigPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["postgres-config delete", "postgres-config get", "postgres-config update"],
};
