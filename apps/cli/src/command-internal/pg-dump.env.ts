import type { PgConnInput } from "./db-connection.service.ts";

/**
 * Pure pg_dump environment builders — no Effect or service dependencies, so the schema/role/
 * config lists and the dry-run expansion stay unit-testable in isolation. Shared by `db dump`,
 * `db pull`'s initial-migra schema dump, and `migration squash`'s before/after/full dumps.
 */

/** Schemas excluded from a schema dump. */
export const INTERNAL_SCHEMAS: ReadonlyArray<string> = [
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

/** Schemas excluded from a data dump. */
export const EXCLUDED_SCHEMAS: ReadonlyArray<string> = [
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

/** Roles preserved verbatim by a role dump. */
export const RESERVED_ROLES: ReadonlyArray<string> = [
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

/** Config settings preserved verbatim by a role dump. */
export const ALLOWED_CONFIGS: ReadonlyArray<string> = [
  // Ref: https://github.com/supabase/postgres/blob/develop/ansible/files/postgresql_config/supautils.conf.j2#L10
  "pgaudit.*",
  "pgrst.*",
  "session_replication_role",
  "statement_timeout",
  "track_io_timing",
];

/** Options controlling a pg_dump invocation. */
export interface DumpOptions {
  readonly schema: ReadonlyArray<string>;
  readonly keepComments: boolean;
  readonly excludeTable: ReadonlyArray<string>;
  /** `true` emits `--column-inserts` instead of `COPY` statements. */
  readonly columnInsert: boolean;
}

export function toDumpEnv(conn: PgConnInput): Record<string, string> {
  return {
    PGHOST: conn.host,
    PGPORT: String(conn.port),
    PGUSER: conn.user,
    PGPASSWORD: conn.password,
    PGDATABASE: conn.database,
  };
}

/** Env assembly for a schema-only dump. */
export function buildSchemaDumpEnv(conn: PgConnInput, opt: DumpOptions): Record<string, string> {
  const env = toDumpEnv(conn);
  if (opt.schema.length > 0) {
    // Must append flag because empty string results in error.
    env["EXTRA_FLAGS"] = `--schema=${opt.schema.join("|")}`;
  } else {
    env["EXCLUDED_SCHEMAS"] = INTERNAL_SCHEMAS.join("|");
  }
  if (!opt.keepComments) {
    env["EXTRA_SED"] = "/^--/d";
  }
  return env;
}

/** Env assembly for a data-only dump. */
export function buildDataDumpEnv(conn: PgConnInput, opt: DumpOptions): Record<string, string> {
  const env = toDumpEnv(conn);
  if (opt.schema.length > 0) {
    env["INCLUDED_SCHEMAS"] = opt.schema.join("|");
  } else {
    env["INCLUDED_SCHEMAS"] = "*";
    env["EXCLUDED_SCHEMAS"] = EXCLUDED_SCHEMAS.join("|");
  }
  const extraFlags: Array<string> = [];
  if (opt.columnInsert) {
    extraFlags.push("--column-inserts", "--rows-per-insert 100000");
  }
  for (const table of opt.excludeTable) {
    const escaped = quoteUpperCase(table);
    // Use separate flags to avoid error: too many dotted names.
    extraFlags.push(`--exclude-table ${escaped}`);
  }
  if (extraFlags.length > 0) {
    env["EXTRA_FLAGS"] = extraFlags.join(" ");
  }
  return env;
}

/** Double-quotes each dot-separated identifier segment (e.g. `public.foo` → `"public"."foo"`). */
export function quoteUpperCase(table: string): string {
  const escaped = table.replaceAll(".", `"."`);
  return `"${escaped}"`;
}

/** Env assembly for a role dump. */
export function buildRoleDumpEnv(conn: PgConnInput, opt: DumpOptions): Record<string, string> {
  const env = toDumpEnv(conn);
  env["RESERVED_ROLES"] = RESERVED_ROLES.join("|");
  env["ALLOWED_CONFIGS"] = ALLOWED_CONFIGS.join("|");
  if (!opt.keepComments) {
    env["EXTRA_SED"] = "/^--/d";
  }
  return env;
}

const isAlphaNum = (c: string): boolean =>
  c === "_" || (c >= "0" && c <= "9") || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

// Shell special variable names: `*#$@!?-` and the single digits 0-9.
const isShellSpecialVar = (c: string): boolean => "*#$@!?-0123456789".includes(c);

/** Returns the variable name referenced by `$`-syntax at the start of `s`, plus the number of characters consumed. */
function getShellName(s: string): { name: string; width: number } {
  if (s.length === 0) return { name: "", width: 0 };
  if (s[0] === "{") {
    if (s.length > 2 && isShellSpecialVar(s[1]!) && s[2] === "}") {
      return { name: s.slice(1, 2), width: 3 };
    }
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
 * Expands `$VAR`/`${VAR}` references in `script` from `env`, ignoring bash default syntax
 * (`${VAR:-x}` resolves `VAR` only) and escaping double quotes in substituted values. Used to
 * render the `--dry-run` script exactly as it will run.
 */
export function expandScript(script: string, env: Record<string, string>): string {
  const mapping = (key: string): string => {
    // Only the name before the first ":" is honored; bash default-value syntax
    // (`${VAR:-x}`) is not otherwise supported.
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
