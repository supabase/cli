import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `start` command group. */
export const startPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["start"],
};
