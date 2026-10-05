import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `login` command group. */
export const loginPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["login"],
};
