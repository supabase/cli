import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `test` command group. */
export const testPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["test db", "test new"],
};
