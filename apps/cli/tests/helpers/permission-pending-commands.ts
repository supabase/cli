/** Leaf command paths that don't declare their permissions with `withPermissions` yet. */
export const PENDING_COMMANDS: ReadonlyArray<string> = [
  "db branch create",
  "db branch delete",
  "db branch list",
  "db branch switch",
  "db remote changes",
  "db remote commit",

  "gen keys",

  "init",

  "stack destroy",
  "stack list",
  "stack logs",
  "stack prepare",
  "stack restart",
  "stack start",
  "stack status",
  "stack stop",

  "start",

  "status",

  "stop",
];
