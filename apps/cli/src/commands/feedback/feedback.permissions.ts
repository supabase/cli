import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `feedback` command group. */
export const feedbackPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["feedback add", "feedback delete"],
};
