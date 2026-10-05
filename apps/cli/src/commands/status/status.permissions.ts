import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `status` command group. */
export const statusPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["status"],
};
