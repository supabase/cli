import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `network-restrictions` command group. */
export const networkRestrictionsPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["network-restrictions get", "network-restrictions update"],
};
