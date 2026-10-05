import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `init` command group. */
export const initPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["init"],
};
