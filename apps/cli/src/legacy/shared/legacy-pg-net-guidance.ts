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
