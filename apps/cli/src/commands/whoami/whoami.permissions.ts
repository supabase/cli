import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `whoami` command group. */
export const whoamiPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["whoami"],
};
