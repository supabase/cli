import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `bootstrap` command group. */
export const bootstrapPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["bootstrap"],
};
