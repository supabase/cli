import type { PermissionGroup } from "../../command-internal/command-permissions/model.ts";

/** Permission mapping for the `vanity-subdomains` command group. */
export const vanitySubdomainsPermissions: PermissionGroup = {
  declared: new Map(),
  pending: [
    "vanity-subdomains activate",
    "vanity-subdomains check-availability",
    "vanity-subdomains delete",
    "vanity-subdomains get",
  ],
};
