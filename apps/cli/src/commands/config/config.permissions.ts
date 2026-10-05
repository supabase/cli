import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `config` command group. */
export const configPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["config diff", "config pull", "config push"],
};
