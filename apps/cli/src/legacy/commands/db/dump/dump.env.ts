import type { LegacyPgConnInput } from "../../../shared/legacy-db-connection.service.ts";

/**
 * Pure pg_dump environment builders, ported 1:1 from Go's `pkg/migration/dump.go`.
 * No Effect or service dependencies, so the schema/role/config lists and the
 * `os.Expand` dry-run expansion stay unit-testable in isolation. Promote to
 * `legacy/shared/` if `db diff` / `db pull` ever need the same env builders.
 */

/** `migration.InternalSchemas` (`pkg/migration/dump.go:18-49`). Used by schema dumps. */
export const LEGACY_INTERNAL_SCHEMAS: ReadonlyArray<string> = [
  "information_schema",
  "pg_*", // Wildcard pattern follows pg_dump
  // Initialised by supabase/postgres image and owned by postgres role
  "_analytics",
  "_realtime",
  "_supavisor",
  "auth",
  "etl",
  "extensions",
  "pgbouncer",
  "realtime",
  "storage",
  "supabase_functions",
  "supabase_migrations",
  // Owned by extensions
  "cron",
  "dbdev",
  "graphql",
  "graphql_public",
  "net",
  "pgmq",
  "pgsodium",
  "pgsodium_masks",
  "pgtle",
  "repack",
  "tiger",
  "tiger_data",
  "timescaledb_*",
  "_timescaledb_*",
  "topology",
  "vault",
];

/** `migration.excludedSchemas` (`pkg/migration/dump.go:51-85`). Used by data dumps. */
export const LEGACY_EXCLUDED_SCHEMAS: ReadonlyArray<string> = [
  "information_schema",
  "pg_*", // Wildcard pattern follows pg_dump
  // Owned by extensions
  // "cron",
  "graphql",
  "graphql_public",
  // "net",
  // "pgmq",
  "pgsodium",
  "pgsodium_masks",
  "pgtle",
  "repack",
  "tiger",
  "tiger_data",
  "timescaledb_*",
  "_timescaledb_*",
  "topology",
  "vault",
  // Managed by Supabase
  // "auth",
  "etl",
  "extensions",
  "pgbouncer",
  "realtime",
  // "storage",
  // "supabase_functions",
  "supabase_migrations",
  // TODO: Remove in a few version in favor of _supabase internal db
  "_analytics",
  "_realtime",
  "_supavisor",
];

/** `migration.reservedRoles` (`pkg/migration/dump.go:86-101`). Used by role dumps. */
export const LEGACY_RESERVED_ROLES: ReadonlyArray<string> = [
  "anon",
  "authenticated",
  "authenticator",
  "cli_login_.*",
  "dashboard_user",
  "pgbouncer",
  "postgres",
  "service_role",
  "supabase_.*",
  // Managed by extensions
  "pgsodium_keyholder",
  "pgsodium_keyiduser",
  "pgsodium_keymaker",
  "pgtle_admin",
];

/** `migration.allowedConfigs` (`pkg/migration/dump.go:102-110`). Used by role dumps. */
export const LEGACY_ALLOWED_CONFIGS: ReadonlyArray<string> = [
  // Ref: https://github.com/supabase/postgres/blob/develop/ansible/files/postgresql_config/supautils.conf.j2#L10
  "pgaudit.*",
  "pgrst.*",
  "session_replication_role",
  "statement_timeout",
  "track_io_timing",
];

/** Options controlling a pg_dump invocation (`pkg/migration/dump.go:112-117`). */
export interface LegacyDumpOptions {
  readonly schema: ReadonlyArray<string>;
  readonly keepComments: boolean;
  readonly excludeTable: ReadonlyArray<string>;
  /** `WithColumnInsert(!useCopy)` — true means emit `--column-inserts`. */
  readonly columnInsert: boolean;
}

/** `migration.toEnv` (`pkg/migration/dump.go:140-148`). */
export function legacyToDumpEnv(conn: LegacyPgConnInput): Record<string, string> {
  return {
    PGHOST: conn.host,
    PGPORT: String(conn.port),
    PGUSER: conn.user,
    PGPASSWORD: conn.password,
    PGDATABASE: conn.database,
  };
}

/** `migration.DumpSchema` env assembly (`pkg/migration/dump.go:152-166`). */
export function legacyBuildSchemaDumpEnv(
  conn: LegacyPgConnInput,
  opt: LegacyDumpOptions,
): Record<string, string> {
  const env = legacyToDumpEnv(conn);
  if (opt.schema.length > 0) {
    // Must append flag because empty string results in error.
    env["EXTRA_FLAGS"] = `--schema=${opt.schema.join("|")}`;
  } else {
    env["EXCLUDED_SCHEMAS"] = LEGACY_INTERNAL_SCHEMAS.join("|");
  }
  if (!opt.keepComments) {
    env["EXTRA_SED"] = "/^--/d";
  }
  return env;
}

/** `migration.DumpData` env assembly (`pkg/migration/dump.go:168-189`). */
export function legacyBuildDataDumpEnv(
  conn: LegacyPgConnInput,
  opt: LegacyDumpOptions,
): Record<string, string> {
  const env = legacyToDumpEnv(conn);
  if (opt.schema.length > 0) {
    env["INCLUDED_SCHEMAS"] = opt.schema.join("|");
  } else {
    env["INCLUDED_SCHEMAS"] = "*";
    env["EXCLUDED_SCHEMAS"] = LEGACY_EXCLUDED_SCHEMAS.join("|");
  }
  const extraFlags: Array<string> = [];
  if (opt.columnInsert) {
    extraFlags.push("--column-inserts", "--rows-per-insert 100000");
  }
  for (const table of opt.excludeTable) {
    const escaped = legacyQuoteUpperCase(table);
    // Use separate flags to avoid error: too many dotted names.
    extraFlags.push(`--exclude-table ${escaped}`);
  }
  if (extraFlags.length > 0) {
    env["EXTRA_FLAGS"] = extraFlags.join(" ");
  }
  return env;
}

/** `migration.quoteUpperCase` (`pkg/migration/dump.go:191-194`). */
export function legacyQuoteUpperCase(table: string): string {
  const escaped = table.replaceAll(".", `"."`);
  return `"${escaped}"`;
}

/** `migration.DumpRole` env assembly (`pkg/migration/dump.go:196-209`). */
export function legacyBuildRoleDumpEnv(
  conn: LegacyPgConnInput,
  opt: LegacyDumpOptions,
): Record<string, string> {
  const env = legacyToDumpEnv(conn);
  env["RESERVED_ROLES"] = LEGACY_RESERVED_ROLES.join("|");
  env["ALLOWED_CONFIGS"] = LEGACY_ALLOWED_CONFIGS.join("|");
  if (!opt.keepComments) {
    env["EXTRA_SED"] = "/^--/d";
  }
  return env;
}

const isAlphaNum = (c: string): boolean =>
  c === "_" || (c >= "0" && c <= "9") || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

// Go's `os.isShellSpecialVar`: `*#$@!?-` and the single digits 0-9.
const isShellSpecialVar = (c: string): boolean => "*#$@!?-0123456789".includes(c);

/**
 * Port of Go's `os.getShellName` (`src/os/env.go`): returns the variable name
 * referenced by `$`-syntax at the start of `s`, plus the number of bytes
 * consumed.
 */
function getShellName(s: string): { name: string; width: number } {
  if (s.length === 0) return { name: "", width: 0 };
  if (s[0] === "{") {
    if (s.length > 2 && isShellSpecialVar(s[1]!) && s[2] === "}") {
      return { name: s.slice(1, 2), width: 3 };
    }
    // Scan to the closing brace, copying the var name.
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "}") {
        if (i === 1) return { name: "", width: 2 }; // bad syntax: `${}`
        return { name: s.slice(1, i), width: i + 1 };
      }
    }
    return { name: "", width: 1 }; // bad syntax: no closing brace
  }
  if (isShellSpecialVar(s[0]!)) {
    return { name: s.slice(0, 1), width: 1 };
  }
  let i = 0;
  while (i < s.length && isAlphaNum(s[i]!)) i++;
  return { name: s.slice(0, i), width: i };
}

/**
 * Port of Go's `dump.noExec` expansion (`internal/db/dump/dump.go:59-77`): expands
 * `$VAR` / `${VAR}` references in `script` from `env`, ignoring bash default
 * syntax (`${VAR:-x}` resolves `VAR` only) and escaping double quotes in the
 * substituted values. Used to render the `--dry-run` script byte-for-byte.
 */
export function legacyExpandScript(script: string, env: Record<string, string>): string {
  const mapping = (key: string): string => {
    // Bash variable expansion is unsupported (golang/go#47187): only the name
    // before the first ":" is honored.
    const name = key.split(":")[0] ?? "";
    const value = env[name] ?? "";
    return value.replaceAll('"', '\\"');
  };

  let buf = "";
  let i = 0;
  let used = false;
  for (let j = 0; j < script.length; j++) {
    if (script[j] === "$" && j + 1 < script.length) {
      used = true;
      buf += script.slice(i, j);
      const { name, width } = getShellName(script.slice(j + 1));
      if (name === "" && width > 0) {
        // Invalid syntax; eat the consumed characters.
      } else if (name === "") {
        buf += script[j]; // `$` not followed by a name: keep it.
      } else {
        buf += mapping(name);
      }
      j += width;
      i = j + 1;
    }
  }
  if (!used) return script;
  return buf + script.slice(i);
}
