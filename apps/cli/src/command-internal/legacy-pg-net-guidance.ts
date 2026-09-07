import type { LegacyDbExecError } from "./legacy-db-connection.errors.ts";

/** Canonical remediation when local migrations need pg_net but webhooks are disabled. */
export const LEGACY_ENABLE_LOCAL_WEBHOOKS_SUGGESTION =
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
export const legacyIsPgNetUnavailableError = (
  error: Pick<LegacyDbExecError, "code" | "message">,
): boolean =>
  (error.code === "3F000" && MISSING_NET_SCHEMA_PATTERN.test(error.message)) ||
  (error.code === "42883" && MISSING_PG_NET_FUNCTION_PATTERN.test(error.message));

const CREATE_PG_NET_EXTENSION_PATTERN = /\bcreate\s+extension\b[\s\S]*?\bpg_net\b/iu;

/**
 * Whether a recorded `supabase_migrations.schema_migrations` statement installs
 * pg_net.
 *
 * Deliberately a loose, over-matching scan (no SQL parse, no schema/quoting
 * awareness) because of the direction the answer is used in: it only ever gates
 * AWAY from dropping the extension. A false positive leaves a user's pg_net
 * installed, which is harmless; a false negative would drop an extension the user's
 * OWN migrations created — and `supabase start` does not replay migrations on an
 * existing volume, so nothing would put it back. The constraint this exists to
 * enforce: the webhooks-disabled convergence drop must never remove
 * migration-owned pg_net.
 */
export const legacyStatementInstallsPgNet = (statement: string): boolean =>
  CREATE_PG_NET_EXTENSION_PATTERN.test(statement);
