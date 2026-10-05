import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `seed` command group. */
export const seedPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["seed buckets"],
};
