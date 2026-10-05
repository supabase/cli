import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `secrets` command group. */
export const secretsPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["secrets list", "secrets set", "secrets unset"],
};
