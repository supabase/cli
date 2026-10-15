/** Leaf command paths that don't declare their permissions with `withPermissions` yet. */
export const PENDING_COMMANDS: ReadonlyArray<string> = [
  "completion bash",
  "completion fish",
  "completion powershell",
  "completion zsh",

  "compute delete",
  "compute list",
  "compute logs",
  "compute new",
  "compute push",
  "compute status",

  "db branch create",
  "db branch delete",
  "db branch list",
  "db branch switch",
  "db remote changes",

  "encryption get-root-key",
  "encryption update-root-key",

  "feedback add",
  "feedback delete",

  "functions delete",
  "functions deploy",
  "functions download",
  "functions list",
  "functions new",
  "functions serve",

  "gen keys",

  "init",

  "issue bug",
  "issue docs",
  "issue feature",

  "login",

  "logout",

  "network-bans get",
  "network-bans remove",

  "network-restrictions get",
  "network-restrictions update",

  "postgres-config delete",
  "postgres-config get",
  "postgres-config update",

  "pull",

  "ssl-enforcement get",
  "ssl-enforcement update",

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

  "telemetry disable",
  "telemetry enable",
  "telemetry status",

  "vanity-subdomains activate",
  "vanity-subdomains check-availability",
  "vanity-subdomains delete",
  "vanity-subdomains get",

  "whoami",
];
