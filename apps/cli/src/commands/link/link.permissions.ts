import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `link` command group. */
export const linkPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["link"],
};
