import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `services` command group. */
export const servicesPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["services"],
};
