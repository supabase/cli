import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `network-bans` command group. */
export const networkBansPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["network-bans get", "network-bans remove"],
};
