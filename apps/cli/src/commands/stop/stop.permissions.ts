import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `stop` command group. */
export const stopPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["stop"],
};
