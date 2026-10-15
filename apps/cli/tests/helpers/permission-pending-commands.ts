/** Leaf command paths that don't declare their permissions with `withPermissions` yet. */
export const PENDING_COMMANDS: ReadonlyArray<string> = [
  "db branch create",
  "db branch delete",
  "db branch list",
  "db branch switch",
  "db remote changes",

  "gen keys",

  "pull",
];
