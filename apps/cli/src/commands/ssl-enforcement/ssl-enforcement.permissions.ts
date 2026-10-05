import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `ssl-enforcement` command group. */
export const sslEnforcementPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["ssl-enforcement get", "ssl-enforcement update"],
};
