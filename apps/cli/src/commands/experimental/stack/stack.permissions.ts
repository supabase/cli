import type { PermissionGroup } from "../../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `stack` command group. */
export const stackPermissions: PermissionGroup = {
  declared: new Map(),
  pending: [
    "stack destroy",
    "stack list",
    "stack logs",
    "stack prepare",
    "stack restart",
    "stack start",
    "stack status",
    "stack stop",
  ],
};
