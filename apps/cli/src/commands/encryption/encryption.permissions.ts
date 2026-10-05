import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `encryption` command group. */
export const encryptionPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["encryption get-root-key", "encryption update-root-key"],
};
