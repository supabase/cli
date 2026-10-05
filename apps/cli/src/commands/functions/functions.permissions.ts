import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `functions` command group. */
export const functionsPermissions: PermissionGroup = {
  declared: new Map(),
  pending: [
    "functions delete",
    "functions deploy",
    "functions download",
    "functions list",
    "functions new",
    "functions serve",
  ],
};
