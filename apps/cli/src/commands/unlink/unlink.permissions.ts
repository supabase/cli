import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `unlink` command group. */
export const unlinkPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["unlink"],
};
