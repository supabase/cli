import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `sso` command group. */
export const ssoPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["sso add", "sso info", "sso list", "sso remove", "sso show", "sso update"],
};
