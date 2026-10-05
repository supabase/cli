import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `migration` command group. */
export const migrationPermissions: PermissionGroup = {
  declared: new Map(),
  pending: [
    "migration down",
    "migration fetch",
    "migration list",
    "migration new",
    "migration repair",
    "migration squash",
    "migration up",
  ],
};
