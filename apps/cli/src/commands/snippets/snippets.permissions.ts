import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `snippets` command group. */
export const snippetsPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["snippets download", "snippets list"],
};
