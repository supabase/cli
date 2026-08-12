import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  CliSuggestionType,
  ErrorActionabilityId,
  statusCodeActionability,
} from "../../shared/telemetry/error-actionability.ts";

/**
 * `--db-url` could not be parsed as a Postgres connection string. Mirrors Go's
 * `pgconn.ParseConfig` failure in `flags.ParseDatabaseConfig`.
 */
export class LegacyDbConfigParseUrlError extends Data.TaggedError("LegacyDbConfigParseUrlError")<{
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
export class LegacyDbConfigLoadError extends Data.TaggedError("LegacyDbConfigLoadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** Transport failure creating a temporary login role (`V1CreateLoginRole`). */
export class LegacyDbConfigLoginRoleNetworkError extends Data.TaggedError(
  "LegacyDbConfigLoginRoleNetworkError",
)<{ readonly message: string; readonly decode?: boolean }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/** Non-201 status creating a temporary login role (`V1CreateLoginRole`). */
export class LegacyDbConfigLoginRoleStatusError extends Data.TaggedError(
  "LegacyDbConfigLoginRoleStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/** Transport failure listing network bans (`V1ListAllNetworkBans`). */
export class LegacyDbConfigListBansNetworkError extends Data.TaggedError(
  "LegacyDbConfigListBansNetworkError",
)<{ readonly message: string; readonly decode?: boolean }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/** Non-2xx status listing network bans (`V1ListAllNetworkBans`). */
export class LegacyDbConfigListBansStatusError extends Data.TaggedError(
  "LegacyDbConfigListBansStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/** Transport failure removing network bans (`V1DeleteNetworkBans`). */
export class LegacyDbConfigUnbanNetworkError extends Data.TaggedError(
  "LegacyDbConfigUnbanNetworkError",
)<{ readonly message: string; readonly decode?: boolean }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.decode === true
      ? { ...actionability.apiStatus, fingerprint_suffix: "api_response" }
      : actionability.externalNetwork;
  }
}

/** Non-2xx status removing network bans (`V1DeleteNetworkBans`). */
export class LegacyDbConfigUnbanStatusError extends Data.TaggedError(
  "LegacyDbConfigUnbanStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return statusCodeActionability(this.status, { notFoundIsInvalidInput: true });
  }
}

/**
 * The linked project's direct database host is unreachable (IPv6-only) and no
 * connection pooler is configured. Byte-matches Go's
 * `"IPv6 is not supported on your current network"` with the `supabase link`
 * suggestion.
 */
export class LegacyDbConfigIpv6Error extends Data.TaggedError("LegacyDbConfigIpv6Error")<{
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
 * Failed to connect to the linked project as the temporary login role after the
 * pooler refresh backoff was exhausted. Mirrors `initPoolerLogin` final
 * `backoff.RetryNotify` failure.
 */
export class LegacyDbConfigConnectTempRoleError extends Data.TaggedError(
  "LegacyDbConfigConnectTempRoleError",
)<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}

/**
 * The configured pooler connection string does not match the linked project ref
 * or its domain falls outside the active profile (MITM guard). Mirrors the
 * `nil`-returning validation branches of `GetPoolerConfig`.
 */
export class LegacyDbConfigPoolerLoginError extends Data.TaggedError(
  "LegacyDbConfigPoolerLoginError",
)<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dbConnection;
  }
}
