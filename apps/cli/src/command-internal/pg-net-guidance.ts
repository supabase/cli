import type { DbExecError } from "./db-connection.errors.ts";

/** Canonical remediation when local migrations need pg_net but webhooks are disabled. */
export const ENABLE_LOCAL_WEBHOOKS_SUGGESTION =
  "Add the following to supabase/config.toml and retry:\n\n" +
  "[experimental.webhooks]\n" +
  "enabled = true";

const MISSING_NET_SCHEMA_PATTERN = /schema "net" does not exist/iu;
const MISSING_PG_NET_FUNCTION_PATTERN = /function net\.http_[a-z0-9_]*\([^)]*\) does not exist/iu;

/**
 * Classifies the PostgreSQL failures produced when a migration calls pg_net while
 * the extension is unavailable. SQLSTATE keeps similarly worded client errors out;
 * the server-reported schema/function identity keeps unrelated undefined objects out.
 */
export const isPgNetUnavailableError = (error: Pick<DbExecError, "code" | "message">): boolean =>
  (error.code === "3F000" && MISSING_NET_SCHEMA_PATTERN.test(error.message)) ||
  (error.code === "42883" && MISSING_PG_NET_FUNCTION_PATTERN.test(error.message));

const CREATE_PG_NET_EXTENSION_PATTERN = /\bcreate\s+extension\b[\s\S]*?\bpg_net\b/iu;

/**
 * Whether a recorded `supabase_migrations.schema_migrations` statement installs pg_net.
 *
 * A loose, over-matching scan is safe here because the answer only ever gates away from
 * dropping the extension: a false positive leaves pg_net installed (harmless), while a false
 * negative would drop an extension the user's own migrations created, with nothing left to
 * restore it.
 */
export const statementInstallsPgNet = (statement: string): boolean =>
  CREATE_PG_NET_EXTENSION_PATTERN.test(statement);
