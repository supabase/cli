import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `notebooks` command group. */
export const notebooksPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["notebooks pull", "notebooks push"],
};
