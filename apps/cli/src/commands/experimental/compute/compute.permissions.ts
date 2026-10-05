import type { PermissionGroup } from "../../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `compute` command group. */
export const computePermissions: PermissionGroup = {
  declared: new Map(),
  pending: [
    "compute delete",
    "compute list",
    "compute logs",
    "compute new",
    "compute push",
    "compute status",
  ],
};
