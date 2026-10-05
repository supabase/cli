import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `storage` command group. */
export const storagePermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["storage cp", "storage ls", "storage mv", "storage rm"],
};
