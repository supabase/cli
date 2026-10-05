import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `logout` command group. */
export const logoutPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["logout"],
};
