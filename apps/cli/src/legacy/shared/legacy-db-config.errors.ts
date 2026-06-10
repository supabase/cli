import { Data } from "effect";

/**
 * `--db-url` could not be parsed as a Postgres connection string. Mirrors Go's
 * `pgconn.ParseConfig` failure in `flags.ParseDatabaseConfig`
 * (`apps/cli-go/internal/utils/flags/db_url.go:64`).
 */
export class LegacyDbConfigParseUrlError extends Data.TaggedError("LegacyDbConfigParseUrlError")<{
  readonly message: string;
}> {}

/**
 * `supabase/config.toml` exists but could not be read or parsed. Mirrors Go's
 * `flags.LoadConfig` → `config.Load` → `mergeFileConfig` returning the read/decode
 * error and aborting, rather than silently running against the default local database
 * (`apps/cli-go/internal/utils/flags/config_path.go:10`, `pkg/config/config.go:528`).
 * A missing file (`os.ErrNotExist` / `PlatformError` reason `"NotFound"`) is not an
 * error — defaults apply, matching Go.
 */
export class LegacyDbConfigLoadError extends Data.TaggedError("LegacyDbConfigLoadError")<{
  readonly message: string;
}> {}

/** Transport failure creating a temporary login role (`V1CreateLoginRole`). */
export class LegacyDbConfigLoginRoleNetworkError extends Data.TaggedError(
  "LegacyDbConfigLoginRoleNetworkError",
)<{ readonly message: string }> {}

/** Non-201 status creating a temporary login role (`V1CreateLoginRole`). */
export class LegacyDbConfigLoginRoleStatusError extends Data.TaggedError(
  "LegacyDbConfigLoginRoleStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

/** Transport failure listing network bans (`V1ListAllNetworkBans`). */
export class LegacyDbConfigListBansNetworkError extends Data.TaggedError(
  "LegacyDbConfigListBansNetworkError",
)<{ readonly message: string }> {}

/** Non-2xx status listing network bans (`V1ListAllNetworkBans`). */
export class LegacyDbConfigListBansStatusError extends Data.TaggedError(
  "LegacyDbConfigListBansStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

/** Transport failure removing network bans (`V1DeleteNetworkBans`). */
export class LegacyDbConfigUnbanNetworkError extends Data.TaggedError(
  "LegacyDbConfigUnbanNetworkError",
)<{ readonly message: string }> {}

/** Non-2xx status removing network bans (`V1DeleteNetworkBans`). */
export class LegacyDbConfigUnbanStatusError extends Data.TaggedError(
  "LegacyDbConfigUnbanStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

/**
 * The linked project's direct database host is unreachable (IPv6-only) and no
 * connection pooler is configured. Byte-matches Go's
 * `"IPv6 is not supported on your current network"` with the `supabase link`
 * suggestion (`db_url.go:101-104`).
 */
export class LegacyDbConfigIpv6Error extends Data.TaggedError("LegacyDbConfigIpv6Error")<{
  readonly message: string;
  readonly suggestion?: string;
}> {}

/**
 * Failed to connect to the linked project as the temporary login role after the
 * pooler refresh backoff was exhausted. Mirrors Go's `initPoolerLogin` final
 * `backoff.RetryNotify` failure (`db_url.go:190-209`).
 */
export class LegacyDbConfigConnectTempRoleError extends Data.TaggedError(
  "LegacyDbConfigConnectTempRoleError",
)<{
  readonly message: string;
  readonly suggestion?: string;
}> {}

/**
 * The configured pooler connection string does not match the linked project ref
 * or its domain falls outside the active profile (MITM guard). Mirrors the
 * `nil`-returning validation branches of Go's `GetPoolerConfig`
 * (`apps/cli-go/internal/utils/connect.go:65-107`).
 */
export class LegacyDbConfigPoolerLoginError extends Data.TaggedError(
  "LegacyDbConfigPoolerLoginError",
)<{
  readonly message: string;
  readonly suggestion?: string;
}> {}
