import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `pull` command group. */
export const pullPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["pull"],
};
