/** Leaf command paths that don't declare their permissions with `withPermissions` yet. */
export const PENDING_COMMANDS: ReadonlyArray<string> = [
  "backups list",
  "backups restore",

  "bootstrap",

  "branches create",
  "branches delete",
  "branches disable",
  "branches get",
  "branches list",
  "branches pause",
  "branches unpause",
  "branches update",

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

  "config diff",
  "config pull",
  "config push",

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

  "domains activate",
  "domains create",
  "domains delete",
  "domains get",
  "domains reverify",

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

  "gen bearer-jwt",
  "gen keys",
  "gen signing-key",
  "gen types",

  "init",

  "inspect db bloat",
  "inspect db blocking",
  "inspect db cache-hit",
  "inspect db calls",
  "inspect db db-stats",
  "inspect db index-sizes",
  "inspect db index-stats",
  "inspect db index-usage",
  "inspect db locks",
  "inspect db long-running-queries",
  "inspect db outliers",
  "inspect db replication-slots",
  "inspect db role-configs",
  "inspect db role-connections",
  "inspect db role-stats",
  "inspect db seq-scans",
  "inspect db table-index-sizes",
  "inspect db table-record-counts",
  "inspect db table-sizes",
  "inspect db table-stats",
  "inspect db total-index-size",
  "inspect db total-table-sizes",
  "inspect db traffic-profile",
  "inspect db unused-indexes",
  "inspect db vacuum-stats",
  "inspect report",

  "issue bug",
  "issue docs",
  "issue feature",

  "link",

  "login",

  "logout",

  "migration down",
  "migration fetch",
  "migration list",
  "migration new",
  "migration repair",
  "migration squash",
  "migration up",

  "network-bans get",
  "network-bans remove",

  "network-restrictions get",
  "network-restrictions update",

  "notebooks pull",
  "notebooks push",

  "orgs create",
  "orgs list",

  "postgres-config delete",
  "postgres-config get",
  "postgres-config update",

  "projects api-keys",
  "projects create",
  "projects delete",
  "projects list",

  "pull",

  "secrets list",
  "secrets set",
  "secrets unset",

  "seed buckets",

  "services",

  "snippets download",
  "snippets list",

  "ssl-enforcement get",
  "ssl-enforcement update",

  "sso add",
  "sso info",
  "sso list",
  "sso remove",
  "sso show",
  "sso update",

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

  "storage cp",
  "storage ls",
  "storage mv",
  "storage rm",

  "telemetry disable",
  "telemetry enable",
  "telemetry status",

  "test db",
  "test new",

  "unlink",

  "vanity-subdomains activate",
  "vanity-subdomains check-availability",
  "vanity-subdomains delete",
  "vanity-subdomains get",

  "whoami",
];
