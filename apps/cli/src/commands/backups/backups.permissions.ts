import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `backups` command group. */
export const backupsPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["backups list", "backups restore"],
};
