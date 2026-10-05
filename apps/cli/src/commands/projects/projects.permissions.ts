import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `projects` command group. */
export const projectsPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["projects api-keys", "projects create", "projects delete", "projects list"],
};
