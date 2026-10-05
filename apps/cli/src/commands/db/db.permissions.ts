import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `db` command group. */
export const dbPermissions: PermissionGroup = {
  declared: new Map(),
  pending: [
    "db advisors",
    "db branch create",
    "db branch delete",
    "db branch list",
    "db branch switch",
    "db diff",
    "db dump",
    "db lint",
    "db pull",
    "db push",
    "db query",
    "db remote changes",
    "db remote commit",
    "db reset",
    "db schema declarative generate",
    "db schema declarative sync",
    "db start",
    "db test",
  ],
};
