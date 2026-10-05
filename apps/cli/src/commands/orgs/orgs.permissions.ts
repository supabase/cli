import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `orgs` command group. */
export const orgsPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["orgs create", "orgs list"],
};
