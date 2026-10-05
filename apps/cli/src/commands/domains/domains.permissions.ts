import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `domains` command group. */
export const domainsPermissions: PermissionGroup = {
  declared: new Map(),
  pending: [
    "domains activate",
    "domains create",
    "domains delete",
    "domains get",
    "domains reverify",
  ],
};
