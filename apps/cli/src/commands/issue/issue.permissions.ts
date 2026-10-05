import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `issue` command group. */
export const issuePermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["issue bug", "issue docs", "issue feature"],
};
