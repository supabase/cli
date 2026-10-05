import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `gen` command group. */
export const genPermissions: PermissionGroup = {
  declared: new Map(),
  pending: ["gen bearer-jwt", "gen keys", "gen signing-key", "gen types"],
};
