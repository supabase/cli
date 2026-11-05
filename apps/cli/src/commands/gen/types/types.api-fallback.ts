import { DbConnectError } from "../../../command-internal/db-connection.errors.ts";
import {
  DbConfigConnectTempRoleError,
  DbConfigIpv6Error,
  DbConfigLoginRoleMissingPrivilegedRoleError,
  DbConfigLoginRoleStatusError,
  LinkedDbNetworkBannedError,
} from "../../../command-internal/db-config.errors.ts";

export type DatabaseAccessError =
  | DbConnectError
  | DbConfigIpv6Error
  | DbConfigConnectTempRoleError
  | LinkedDbNetworkBannedError
  | DbConfigLoginRoleMissingPrivilegedRoleError
  | DbConfigLoginRoleStatusError;

/**
 * Whether the project database could not be reached or accessed, as opposed to a query, generator,
 * config or project-lookup failure. Every `DbConnectError` is dial, TLS or authentication level:
 * introspection failures arrive as `GenTypesGenerationError`. A login-role status counts only
 * when the API refused the caller (401/403), not when it failed.
 */
export const isDatabaseAccessError = (error: unknown): error is DatabaseAccessError =>
  error instanceof DbConnectError ||
  error instanceof DbConfigIpv6Error ||
  error instanceof DbConfigConnectTempRoleError ||
  error instanceof LinkedDbNetworkBannedError ||
  error instanceof DbConfigLoginRoleMissingPrivilegedRoleError ||
  (error instanceof DbConfigLoginRoleStatusError && (error.status === 401 || error.status === 403));

const firstLine = (message: string) => message.split("\n", 1)[0]?.trim() ?? "";

export const apiFallbackWarning = (error: DatabaseAccessError) =>
  `Warning: Could not connect to the project database (${firstLine(error.message)}). ` +
  "Falling back to the Management API, whose types ignore [api].extra_search_path. " +
  "To generate them with the CLI, allow this machine's IP in the project's network restrictions " +
  "or set SUPABASE_DB_PASSWORD. This fallback will be removed in the next major version.";
