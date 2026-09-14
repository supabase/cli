import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  CliSuggestionType,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../shared/telemetry/error-actionability.ts";

/** `--db-url` could not be parsed as a Postgres connection string. */
export class DbConfigParseUrlError extends Data.TaggedError("DbConfigParseUrlError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `supabase/config.toml` exists but could not be read or parsed: the read/decode
 * error aborts the load, rather than silently running against the default local database.
 * A missing file (`os.ErrNotExist` / `PlatformError` reason `"NotFound"`) is not an
 * error — defaults apply.
 */
export class DbConfigLoadError extends Data.TaggedError("DbConfigLoadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** Transport failure creating a temporary login role (`V1CreateLoginRole`). */
export class DbConfigLoginRoleNetworkError extends Data.TaggedError(
  "DbConfigLoginRoleNetworkError",
)<{ readonly message: string; readonly decode?: boolean }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/** Non-201 status creating a temporary login role (`V1CreateLoginRole`). */
export class DbConfigLoginRoleStatusError extends Data.TaggedError("DbConfigLoginRoleStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/** Transport failure listing network bans (`V1ListAllNetworkBans`). */
export class DbConfigListBansNetworkError extends Data.TaggedError("DbConfigListBansNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/** Non-2xx status listing network bans (`V1ListAllNetworkBans`). */
export class DbConfigListBansStatusError extends Data.TaggedError("DbConfigListBansStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/** Transport failure removing network bans (`V1DeleteNetworkBans`). */
export class DbConfigUnbanNetworkError extends Data.TaggedError("DbConfigUnbanNetworkError")<{
  readonly message: string;
  readonly decode?: boolean;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/** Non-2xx status removing network bans (`V1DeleteNetworkBans`). */
export class DbConfigUnbanStatusError extends Data.TaggedError("DbConfigUnbanStatusError")<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/**
 * The linked project's direct database host is unreachable (IPv6-only) and no connection pooler
 * is configured. The message text is exact: `"IPv6 is not supported on your current network"`.
 */
export class DbConfigIpv6Error extends Data.TaggedError("DbConfigIpv6Error")<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    // The rendered remediation is "Run supabase link --project-ref <ref> to
    // setup IPv4 connection", so the suggestion is link-shaped even though the
    // category stays db_connection.
    return {
      ...actionability.dbConnection,
      suggestion_type: CliSuggestionType.LinkProject,
      suggested_command: "supabase link",
    };
  }
}

/**
 * Failed to connect to the linked project as the temporary login role after the pooler refresh
 * backoff was exhausted.
 */
export class DbConfigConnectTempRoleError extends Data.TaggedError("DbConfigConnectTempRoleError")<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

/**
 * The configured pooler connection string does not match the linked project ref, or its domain
 * falls outside the active profile (MITM guard).
 */
export class DbConfigPoolerLoginError extends Data.TaggedError("DbConfigPoolerLoginError")<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}
