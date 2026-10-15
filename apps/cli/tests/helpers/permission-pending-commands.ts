/** Leaf command paths that don't declare their permissions with `withPermissions` yet. */
export const PENDING_COMMANDS: ReadonlyArray<string> = [
  "completion bash",
  "completion fish",
  "completion powershell",
  "completion zsh",

  "db branch create",
  "db branch delete",
  "db branch list",
  "db branch switch",
  "db remote changes",

  "feedback add",
  "feedback delete",

  "gen keys",

  "issue bug",
  "issue docs",
  "issue feature",

  "login",

  "logout",

  "pull",

  "telemetry disable",
  "telemetry enable",
  "telemetry status",

  "whoami",
];
