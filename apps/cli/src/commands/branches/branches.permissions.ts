import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `branches` command group. */
export const branchesPermissions: PermissionGroup = {
  declared: new Map(),
  pending: [
    "branches create",
    "branches delete",
    "branches disable",
    "branches get",
    "branches list",
    "branches pause",
    "branches unpause",
    "branches update",
  ],
};
