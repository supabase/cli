import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { ENV_CAPTURE_REGEX, type ProjectConfig } from "@supabase/config";
import { defaultJwtSecret, defaultPublishableKey, defaultSecretKey } from "@supabase/stack/effect";
import { Schema } from "effect";

import {
  resolveRemoteJwks,
  resolveThirdPartyIssuerUrl,
  thirdPartyIssuerUrlUnchecked,
  toPublicJwk,
  type ThirdPartyProvidersLike,
} from "../../shared/auth/jwks.ts";
import { legacyResolveApiExternalUrl } from "./legacy-api-url.ts";
import { legacySanitizeProjectId } from "./legacy-docker-ids.ts";
import {
  legacyApiTlsCertReadErrorMessage,
  legacyApiTlsKeyReadErrorMessage,
  type LegacyAnalyticsInput,
  type LegacyApiInput,
  type LegacyAuthInput,
  type LegacyCaptchaInput,
  LegacyConfigValidateError,
  type LegacyConfigValidationInput,
  type LegacyDbInput,
  legacyEmailContentPathReadErrorMessage,
  type LegacyExperimentalInput,
  type LegacyHookInput,
  type LegacyLocalSmtpInput,
  type LegacyMfaFactorInput,
  legacyParseGoBool,
  type LegacyPasskeyInput,
  legacyResolveApiTlsPath,
  legacyResolveEmailTemplateContentPath,
  legacyResolveSigningKeysPath,
  legacySigningKeysDecodeErrorMessage,
  legacySigningKeysReadErrorMessage,
  type LegacySmtpInput,
  type LegacyStudioInput,
  type LegacyThirdPartyInput,
  legacyValidateResolvedConfig,
} from "./legacy-config-validate.ts";
import {
  LEGACY_DEFAULT_SIGNING_KEY,
  legacyGenerateAsymmetricGoJwt,
  legacyGenerateGoJwt,
  type LegacyJwk,
} from "./legacy-go-jwt.ts";
import {
  legacyCollectDotenvPrivateKeys,
  legacyDecryptSecret,
  legacyIsEncryptedSecret,
} from "./legacy-vault-decrypt.ts";

/**
 * Go-parity derived local-dev config values, ported from `utils.Config`'s
 * post-load defaulting (`pkg/config/config.go:406-441,748-758`) and
 * `utils.GetApiUrl`/status's `toValues()` (`internal/utils/config.go:255-268`,
 * `internal/status/status.go:52-95`). `@supabase/config`'s schema has no field for
 * a handful of Go constants (`db.password`, the S3 credential triple) — those are
 * Go-hardcoded literals, reproduced here rather than added to the shared schema
 * (`pkg/config/config.go:408,437-441`).
 *
 * Kept generic (no `status`-specific shaping) so a future native `start`/`restart`
 * port can reuse it instead of re-deriving these values — see the plan's
 * "Files to create" note. Do not fold this into `legacy-storage-credentials.ts`;
 * that module resolves credentials through a different (HTTP/tenant-aware) path
 * for the remote-project branch, which this pure resolver does not need (the
 * shared `<scheme>://<host>:<port>` derivation itself lives in
 * `legacy-api-url.ts`, used by both).
 */

/** Go's `Db.Password` default (`pkg/config/config.go:408`) — never present in config.toml. */
const DEFAULT_DB_PASSWORD = "postgres";

/** Go's hardcoded local S3 credentials (`pkg/config/config.go:437-441`). */
const DEFAULT_S3_ACCESS_KEY_ID = "625729a08b95bf1b7ff351a663f3a23c";
const DEFAULT_S3_SECRET_ACCESS_KEY =
  "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907";
const DEFAULT_S3_REGION = "local";

/**
 * Go's `Db.RootKey` default (`apps/cli-go/pkg/config/config.go:460-462`).
 * Exported (not just a local default) so `start`'s Postgres container-spec
 * builder (`postgres.service.ts`) shares this one literal instead of a second
 * copy — `db.root_key` isn't modeled in `@supabase/config`'s schema, so it's
 * resolved below off the raw document the same way `jwtSecret` is resolved.
 */
export const LEGACY_POSTGRES_DEFAULT_ROOT_KEY =
  "d4dc5b6d4a1d6a10b2c1e76112c994d65db7cec380572cc1839624d4be3fa275";

export interface LegacyLocalConfigValues {
  readonly apiUrl: string;
  readonly apiPort: number;
  readonly dbPort: number;
  /** Already env-overridden `studio.port` (`SUPABASE_STUDIO_PORT`) — see `apiPort`/`dbPort` for the same pattern. */
  readonly studioPort: number;
  readonly rootKey: string;
  /**
   * Already-resolved (env-overridden, decrypted-if-`encrypted:`) `studio.
   * openai_api_key`. Go types this as a `config.Secret` (`pkg/config/
   * config.go:264`), decrypted by `DecryptSecretHookFunc` at decode time
   * (`secret.go:30-46,77-108`) for both the TOML value and any
   * `SUPABASE_STUDIO_OPENAI_API_KEY` override (Go's generic Viper
   * `AutomaticEnv` binding, `config.go:582-586`) — same treatment as
   * `jwtSecret`/the API keys below, via the same `legacyDecryptAuthSecret` helper.
   */
  readonly openaiApiKey: string | undefined;
  readonly authSiteUrl: string;
  readonly authJwtIssuer: string | undefined;
  readonly authJwtExpiry: number;
  readonly authAdditionalRedirectUrls: ReadonlyArray<string>;
  readonly authEnableSignup: boolean;
  readonly authEnableAnonymousSignIns: boolean;
  readonly authEnableRefreshTokenRotation: boolean;
  readonly authRefreshTokenReuseInterval: number;
  readonly authEnableManualLinking: boolean;
  readonly authMinimumPasswordLength: number;
  readonly authPasswordRequirements: string;
  readonly restUrl: string;
  readonly graphqlUrl: string;
  readonly functionsUrl: string;
  readonly mcpUrl: string;
  readonly studioUrl: string;
  readonly mailpitUrl: string;
  readonly dbUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly jwtSecret: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly storageS3Url: string;
  readonly storageS3AccessKeyId: string;
  readonly storageS3SecretAccessKey: string;
  readonly storageS3Region: string;
  /** Already env-overridden `analytics.enabled` (`SUPABASE_ANALYTICS_ENABLED`). */
  readonly analyticsEnabled: boolean;
  /** Already env-overridden `analytics.backend` (`SUPABASE_ANALYTICS_BACKEND`), hard-validated like Go's `LogflareBackend`. */
  readonly analyticsBackend: "postgres" | "bigquery";
  /** Already env-overridden `analytics.gcp_project_id` (`SUPABASE_ANALYTICS_GCP_PROJECT_ID`). */
  readonly gcpProjectId: string;
  /** Already env-overridden `analytics.gcp_project_number` (`SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER`). */
  readonly gcpProjectNumber: string;
  /** Already env-overridden `analytics.gcp_jwt_path` (`SUPABASE_ANALYTICS_GCP_JWT_PATH`). */
  readonly gcpJwtPath: string;
}

/**
 * Go's `utils.GetApiUrl(path)` (`internal/utils/config.go:255-268`): appends
 * `path` to the resolved external URL. Go's own fallback branch (building a bare
 * `http://host:port` when `Config.Api.ExternalUrl` is empty) is unreachable in
 * practice because `config.Load` already defaults `ExternalUrl` before `status`
 * runs — `resolveApiExternalUrl` reproduces that same default, so `apiExternalUrl`
 * passed in here is never empty.
 */
function apiUrlWithPath(apiExternalUrl: string, path: string): string {
  return `${apiExternalUrl}${path}`;
}

/**
 * Thrown by {@link legacyResolveLocalConfigValues} when `auth.jwt_secret` is
 * configured but too short to sign with, mirroring Go's `Config.Validate`
 * (`pkg/config/apikeys.go:45-47`) — that check runs at config-load time, before
 * any command renders output, so no local dev stack can even start with a
 * short secret.
 */
export class LegacyInvalidJwtSecretError extends Error {
  constructor() {
    super("Invalid config for auth.jwt_secret. Must be at least 16 characters");
    this.name = "LegacyInvalidJwtSecretError";
  }
}

/** Go's minimum `auth.jwt_secret` length (`pkg/config/apikeys.go:46`). */
const MIN_JWT_SECRET_LENGTH = 16;

/**
 * Thrown by {@link legacyEnvOverridePort} when a `SUPABASE_*_PORT` env/dotenv
 * override doesn't parse as a valid port, mirroring Go's `Config.Load`
 * (`pkg/config/config.go:749-756`): `v.UnmarshalExact` decodes with
 * `WeaklyTypedInput` on (viper's `defaultDecoderConfig`, never reset by our
 * decoder options), so mapstructure's `decodeUint` runs `strconv.ParseUint`
 * on the override string and hard-fails config loading on a bad value —
 * there is no Go code path that reaches `status`/`stop` with a malformed
 * port override. The message text isn't a byte-match for mapstructure's
 * internal error (that's viper/mapstructure library text, not a Go-authored
 * string), but the parity-relevant part — hard-fail, same field name — is.
 */
export class LegacyInvalidPortEnvOverrideError extends Error {
  constructor(dottedFieldPath: string, value: string) {
    super(`Invalid config for ${dottedFieldPath}: cannot parse "${value}" as a port`);
    this.name = "LegacyInvalidPortEnvOverrideError";
  }
}

/** Go's `uint16` port fields' valid range (`pkg/config/db.go:84`, `pkg/config/api.go:29`, etc). */
const MAX_PORT = 65535;

/**
 * Port-flavored sibling of {@link legacyEnvOverride}/{@link legacyEnvOverrideBool}
 * for `SUPABASE_*_PORT` fields Go decodes as `uint16` rather than a plain
 * string. Unlike the boolean sibling — which intentionally falls back to
 * `configured` on a malformed override — a bad port override is a genuine
 * Go-parity hard failure (see {@link LegacyInvalidPortEnvOverrideError}), not
 * a leniency case: Go never proceeds with the pre-override value on a decode
 * error, it fails config loading outright.
 */
export function legacyEnvOverridePort(
  name: string,
  configuredPort: number,
  dottedFieldPath: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  const value = legacyEnvOverride(name, undefined, projectEnvValues);
  if (value === undefined) return configuredPort;
  if (!/^\d+$/.test(value)) {
    throw new LegacyInvalidPortEnvOverrideError(dottedFieldPath, value);
  }
  const port = Number(value);
  if (port > MAX_PORT) {
    throw new LegacyInvalidPortEnvOverrideError(dottedFieldPath, value);
  }
  return port;
}

/**
 * Go's `Config.Load` binds Viper with `SetEnvPrefix("SUPABASE")` +
 * `AutomaticEnv()` + a `.`→`_` key replacer (`pkg/config/config.go:529-535`),
 * so ANY config field can be overridden by a `SUPABASE_<DOTTED_KEY>` env var,
 * generically across the whole struct — not just auth fields
 * (`config_test.go:351,1061` exercise this against `auth.site_url`, and
 * `internal/status/status.go:52-95`'s `toValues()` reads `utils.Config.*`
 * directly, so every already-overridden field is automatically reflected in
 * `status`'s output). This resolves it for every field this module derives a
 * URL/port from, at the same higher-than-config.toml precedence Viper gives
 * env vars. An empty env var is treated as unset, matching Viper's default
 * (`AllowEmptyEnv` is never enabled in `config.go`).
 *
 * Viper's `AutomaticEnv` binding runs AFTER `Config.Load`'s `loadNestedEnv`
 * (`config.go:735-738`), which loads `supabase/.env`(.local) and project-root
 * dotenv files into the process env before any `SUPABASE_*` var is read
 * (`config.go:1169-1207`) — so a value that lives only in one of those files,
 * not the ambient shell, must still be visible here. `projectEnvValues` is
 * that already-resolved map (see `legacyResolveProjectEnvironmentValues`);
 * falling back to `process.env` covers the "no `supabase/` project found"
 * case, where `projectEnvValues` is `undefined`.
 *
 * The resolved override string itself can be a further `env(VAR)` indirection
 * (e.g. `SUPABASE_API_ENABLED=env(API_ENABLED)`) — Go's `LoadEnvHook`
 * (`decode_hooks.go:15-23`) is the first mapstructure decode hook composed
 * into `v.UnmarshalExact` (`config.go:749-753,769-772`), so it resolves
 * `env(...)` on every string mapstructure decodes into the struct, regardless
 * of whether Viper sourced that string from `config.toml` or a `SUPABASE_*`
 * `AutomaticEnv` override (`config.go:582-586`) — Viper's `Get()` just returns
 * a string; the hook chain doesn't know or care where it came from. Resolved
 * with the same `projectEnvValues ?? process.env` precedence and non-empty
 * gate as the outer lookup (mirroring `decode_hooks.go:19-24`'s `len(env) > 0`
 * check); an unresolved/empty indirection leaves the `env(VAR)` literal
 * untouched, same as Go.
 */
export function legacyEnvOverride(
  name: string,
  configured: string | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const value = projectEnvValues?.[name] ?? process.env[name];
  if (value === undefined || value.length === 0) return configured;
  const indirection = ENV_CAPTURE_REGEX.exec(value)?.[1];
  if (indirection === undefined) return value;
  const resolved = projectEnvValues?.[indirection] ?? process.env[indirection];
  return resolved !== undefined && resolved.length > 0 ? resolved : value;
}

/**
 * Thrown by {@link legacyEnvOverrideBool} when a `SUPABASE_*_ENABLED` (or other
 * bool-typed) env/dotenv override doesn't parse as one of Go's accepted bool
 * spellings, mirroring Go's `Config.Load` (`pkg/config/config.go:749-756`):
 * `v.UnmarshalExact` decodes with `WeaklyTypedInput` on (viper's
 * `defaultDecoderConfig`, never reset by our decoder options — same mechanism
 * as {@link LegacyInvalidPortEnvOverrideError}), so mapstructure's `decodeBool`
 * runs `strconv.ParseBool` on the override string and hard-fails config
 * loading on a bad value — there is no Go code path that reaches `status`/
 * `stop` with a malformed bool override.
 */
export class LegacyInvalidBoolEnvOverrideError extends Error {
  constructor(dottedFieldPath: string, value: string) {
    super(`Invalid config for ${dottedFieldPath}: cannot parse "${value}" as a bool`);
    this.name = "LegacyInvalidBoolEnvOverrideError";
  }
}

/**
 * Boolean-flavored sibling of {@link legacyEnvOverride} for `SUPABASE_*` fields Go
 * decodes as a native bool (`api.tls.enabled`, `auth.enabled`, and every other
 * `<section>.enabled` gate `status`/`stop` read — see `legacy-status-values.ts`)
 * rather than a string/number — those are bound by the same generic Viper
 * mechanism (`ExperimentalBindStruct` + `SetEnvPrefix("SUPABASE")` +
 * `AutomaticEnv()`, `pkg/config/config.go:582-586`), but the override string
 * must be decoded with Go's own `strconv.ParseBool` acceptance set
 * ({@link legacyParseGoBool}) instead of used verbatim. Unlike a plain string
 * override — where an unparsed value has no Go-observable failure mode — a
 * malformed bool override is a genuine Go-parity hard failure (see
 * {@link LegacyInvalidBoolEnvOverrideError}), same as
 * {@link LegacyInvalidPortEnvOverrideError} for ports: Go never proceeds with
 * the pre-override value on a decode error, it fails config loading outright.
 *
 * Exported (not just used internally) because `legacy-status-values.ts`'s own
 * `<section>.enabled` gates need this same override treatment — Go's
 * `status.toValues()` reads `utils.Config.*.Enabled` post-Viper-override for
 * every gated service, not only auth.
 */
export function legacyEnvOverrideBool(
  name: string,
  configured: boolean,
  dottedFieldPath: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): boolean {
  const value = legacyEnvOverride(name, undefined, projectEnvValues);
  if (value === undefined) return configured;
  const parsed = legacyParseGoBool(value);
  if (parsed === undefined) {
    throw new LegacyInvalidBoolEnvOverrideError(dottedFieldPath, value);
  }
  return parsed;
}

/**
 * Thrown by {@link envOverrideAnalyticsBackend} when `SUPABASE_ANALYTICS_BACKEND`
 * doesn't match one of Go's `LogflareBackend` values. `Analytics.Backend` is
 * typed `LogflareBackend` (`pkg/config/config.go:303`), and
 * `LogflareBackend.UnmarshalText` (`config.go:60-65`) hard-rejects anything
 * outside `{postgres, bigquery}` — that runs inside the same
 * `v.UnmarshalExact` decode call (`config.go:749-756`) every other
 * `SUPABASE_*` override goes through, so a malformed override fails config
 * loading outright, same mechanism as {@link LegacyInvalidPortEnvOverrideError}/
 * {@link LegacyInvalidBoolEnvOverrideError}.
 */
export class LegacyInvalidAnalyticsBackendEnvOverrideError extends Error {
  constructor(dottedFieldPath: string, value: string) {
    super(
      `Invalid config for ${dottedFieldPath}: cannot parse "${value}" as one of "postgres", "bigquery"`,
    );
    this.name = "LegacyInvalidAnalyticsBackendEnvOverrideError";
  }
}

/**
 * `analytics.backend`-flavored sibling of {@link legacyEnvOverridePort}/
 * {@link legacyEnvOverrideBool} for the one `SUPABASE_*` override this file
 * decodes as a Go text-unmarshalled enum rather than a string/number/bool —
 * see {@link LegacyInvalidAnalyticsBackendEnvOverrideError}. Validates the
 * override-or-configured value with a SINGLE check (rather than only
 * validating the override, trusting the schema for the configured value),
 * matching Go more closely: viper merges the config.toml value and any env
 * override into one string BEFORE `UnmarshalExact` calls `UnmarshalText`
 * exactly once on the resolved value (`config.go:749-756`), not once per
 * source. `@supabase/config`'s `stringEnum` (`packages/config/src/
 * analytics.ts:31-39`) already guards the `config.toml`-sourced value at
 * decode time, so this is belt-and-suspenders for that source and the sole
 * guard for the env-override one, which bypasses that schema entirely.
 */
function envOverrideAnalyticsBackend(
  configured: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): "postgres" | "bigquery" {
  const value =
    legacyEnvOverride("SUPABASE_ANALYTICS_BACKEND", undefined, projectEnvValues) ?? configured;
  if (value !== "postgres" && value !== "bigquery") {
    throw new LegacyInvalidAnalyticsBackendEnvOverrideError("analytics.backend", value);
  }
  return value;
}

/**
 * Thrown by {@link legacyEnvOverrideRealtimeIpVersion} when
 * `SUPABASE_REALTIME_IP_VERSION` doesn't match Go's `AddressFamily`
 * (`pkg/config/config.go:67-81`) — `UnmarshalText` hard-rejects anything
 * outside `{IPv4, IPv6}`, same mechanism as
 * {@link LegacyInvalidAnalyticsBackendEnvOverrideError}.
 */
export class LegacyInvalidRealtimeIpVersionEnvOverrideError extends Error {
  constructor(dottedFieldPath: string, value: string) {
    super(
      `Invalid config for ${dottedFieldPath}: cannot parse "${value}" as one of "IPv4", "IPv6"`,
    );
    this.name = "LegacyInvalidRealtimeIpVersionEnvOverrideError";
  }
}

/**
 * `realtime.ip_version`-flavored sibling of {@link envOverrideAnalyticsBackend}
 * — Go's `Realtime.IpVersion` is `AddressFamily`, text-unmarshalled the same
 * way `Analytics.Backend` is, so the override-or-configured value is
 * validated with a single check to match Go's one-shot `UnmarshalText` call.
 */
export function legacyEnvOverrideRealtimeIpVersion(
  configured: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): "IPv4" | "IPv6" {
  const value =
    legacyEnvOverride("SUPABASE_REALTIME_IP_VERSION", undefined, projectEnvValues) ?? configured;
  if (value !== "IPv4" && value !== "IPv6") {
    throw new LegacyInvalidRealtimeIpVersionEnvOverrideError("realtime.ip_version", value);
  }
  return value;
}

/** `SUPABASE_REALTIME_MAX_HEADER_LENGTH` — see {@link legacyEnvOverrideUint}. */
export function legacyEnvOverrideRealtimeMaxHeaderLength(
  configured: number,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  return legacyEnvOverrideUint(
    "SUPABASE_REALTIME_MAX_HEADER_LENGTH",
    "realtime.max_header_length",
    configured,
    projectEnvValues,
  );
}

/** `SUPABASE_API_MAX_ROWS` — see {@link legacyEnvOverrideUint}. */
export function legacyEnvOverrideApiMaxRows(
  configured: number,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  return legacyEnvOverrideUint(
    "SUPABASE_API_MAX_ROWS",
    "api.max_rows",
    configured,
    projectEnvValues,
  );
}

/**
 * Thrown by {@link legacyEnvOverridePoolMode} when `SUPABASE_DB_POOLER_POOL_MODE`
 * doesn't match Go's `PoolMode` (`pkg/config/db.go:14-26`) — `UnmarshalText`
 * hard-rejects anything outside `{transaction, session}`, same mechanism as
 * {@link LegacyInvalidRealtimeIpVersionEnvOverrideError}.
 */
export class LegacyInvalidPoolModeEnvOverrideError extends Error {
  constructor(dottedFieldPath: string, value: string) {
    super(
      `Invalid config for ${dottedFieldPath}: cannot parse "${value}" as one of "transaction", "session"`,
    );
    this.name = "LegacyInvalidPoolModeEnvOverrideError";
  }
}

/**
 * `db.pooler.pool_mode`-flavored sibling of {@link legacyEnvOverrideRealtimeIpVersion}
 * — Go's `Pooler.PoolMode` is `PoolMode`, text-unmarshalled the same way
 * `Realtime.IpVersion` is, so the override-or-configured value is validated
 * with a single check to match Go's one-shot `UnmarshalText` call.
 */
export function legacyEnvOverridePoolMode(
  configured: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): "transaction" | "session" {
  const value =
    legacyEnvOverride("SUPABASE_DB_POOLER_POOL_MODE", undefined, projectEnvValues) ?? configured;
  if (value !== "transaction" && value !== "session") {
    throw new LegacyInvalidPoolModeEnvOverrideError("db.pooler.pool_mode", value);
  }
  return value;
}

/**
 * Thrown by {@link legacyEnvOverrideEdgeRuntimePolicy} when
 * `SUPABASE_EDGE_RUNTIME_POLICY` doesn't match Go's `RequestPolicy`
 * (`pkg/config/config.go:83-96`) — `UnmarshalText` hard-rejects anything
 * outside `{per_worker, oneshot}`, same mechanism as
 * {@link LegacyInvalidPoolModeEnvOverrideError}.
 */
export class LegacyInvalidEdgeRuntimePolicyEnvOverrideError extends Error {
  constructor(dottedFieldPath: string, value: string) {
    super(
      `Invalid config for ${dottedFieldPath}: cannot parse "${value}" as one of "per_worker", "oneshot"`,
    );
    this.name = "LegacyInvalidEdgeRuntimePolicyEnvOverrideError";
  }
}

/**
 * `edge_runtime.policy`-flavored sibling of {@link legacyEnvOverridePoolMode}
 * — Go's `EdgeRuntime.Policy` is `RequestPolicy`, text-unmarshalled the same
 * way `Pooler.PoolMode` is, so the override-or-configured value is validated
 * with a single check to match Go's one-shot `UnmarshalText` call.
 */
export function legacyEnvOverrideEdgeRuntimePolicy(
  configured: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): "per_worker" | "oneshot" {
  const value =
    legacyEnvOverride("SUPABASE_EDGE_RUNTIME_POLICY", undefined, projectEnvValues) ?? configured;
  if (value !== "per_worker" && value !== "oneshot") {
    throw new LegacyInvalidEdgeRuntimePolicyEnvOverrideError("edge_runtime.policy", value);
  }
  return value;
}

/** `SUPABASE_DB_POOLER_DEFAULT_POOL_SIZE` — see {@link legacyEnvOverrideUint}. */
export function legacyEnvOverrideDefaultPoolSize(
  configured: number,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  return legacyEnvOverrideUint(
    "SUPABASE_DB_POOLER_DEFAULT_POOL_SIZE",
    "db.pooler.default_pool_size",
    configured,
    projectEnvValues,
  );
}

/** `SUPABASE_DB_POOLER_MAX_CLIENT_CONN` — see {@link legacyEnvOverrideUint}. */
export function legacyEnvOverrideMaxClientConn(
  configured: number,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  return legacyEnvOverrideUint(
    "SUPABASE_DB_POOLER_MAX_CLIENT_CONN",
    "db.pooler.max_client_conn",
    configured,
    projectEnvValues,
  );
}

/**
 * Decrypts a resolved auth identity-key field (`jwt_secret`, `publishable_key`,
 * `secret_key`, `anon_key`, `service_role_key`) when it's a dotenvx `encrypted:`
 * value, mirroring Go's `DecryptSecretHookFunc` (`pkg/config/secret.go:30-73`),
 * which Go runs unconditionally during `UnmarshalExact` for every
 * `config.Secret`-typed field (`pkg/config/auth.go:181-185` types these five as
 * `Secret`) — an undecryptable value aborts config loading with
 * `failed to parse config: <error>` (`config.go:704`) before `status`/`stop`
 * continue. `@supabase/config`'s schema only tags these fields for later
 * `Redacted` wrapping (`packages/config/src/lib/env.ts`) and never decrypts, so
 * without this step a valid `encrypted:` secret would be used as literal (wrong)
 * key material and a malformed one would silently pass through instead of
 * failing like Go does.
 *
 * Applied AFTER {@link legacyEnvOverride}, matching Go: an env-sourced override lands
 * on the same `config.Secret` field and goes through the same decode hook as a
 * TOML-sourced value, so `SUPABASE_AUTH_JWT_SECRET=encrypted:...` is decrypted
 * too, not just the config.toml value.
 */
function legacyDecryptAuthSecret(
  value: string | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (value === undefined || !legacyIsEncryptedSecret(value)) return value;
  const dotenvPrivateKeys = legacyCollectDotenvPrivateKeys({ ...projectEnvValues, ...process.env });
  const decrypted = legacyDecryptSecret(value, dotenvPrivateKeys);
  if (!decrypted.ok) {
    throw new LegacyConfigValidateError(`failed to parse config: ${decrypted.error}`);
  }
  return decrypted.value;
}

/**
 * `[auth.email.smtp]`'s full resolved field set, including Go's
 * presence-based `enabled` default. Exported so any caller that needs GoTrue's
 * actual SMTP-vs-Mailpit decision (not just validation) can reuse this instead
 * of re-deriving it from the schema-decoded, always-`enabled: false`-when-
 * absent `config.auth.email.smtp` — see `start.handler.ts`'s
 * `resolveGotrueEnvInput`, which used to do exactly that.
 *
 * Go's `[auth.email.smtp]` presence-based `enabled` default
 * (`pkg/config/config.go:743-748`): when the TOML table is present but omits
 * `enabled`, Go treats it as `true` — a genuinely presence-based default
 * `@supabase/config`'s schema can't see (it always decodes `smtp.enabled` to
 * `false` when the key is absent), so this reads the raw `authDocument` too.
 * `auth.email.smtp.*` is Viper-bound like every other nested field once
 * `[auth.email.smtp]` is present in config.toml (`ExperimentalBindStruct`/
 * `AutomaticEnv`, `config.go:581-586`), so `SUPABASE_AUTH_EMAIL_SMTP_ENABLED`/
 * `_HOST`/`_PORT`/`_USER`/`_PASS`/`_ADMIN_EMAIL`/`_SENDER_NAME` overrides
 * apply before `Auth.Email.validate` runs (`config.go:1325-1344`) — layered on
 * top of the presence-aware raw-document read above, same
 * `legacyEnvOverride`/`legacyEnvOverridePort` precedent as every other field in this file.
 * `sender_name` (`pkg/config/auth.go:254-262`) is an equally Viper-bound
 * regular field, just not needed by validation (hence absent from
 * {@link LegacySmtpInput}).
 */
export function legacyResolveAuthEmailSmtp(
  authDocument: Readonly<Record<string, unknown>> | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): (LegacySmtpInput & { readonly senderName: string | undefined }) | undefined {
  const smtpDoc = asRecord(asRecord(authDocument?.["email"])?.["smtp"]);
  if (smtpDoc === undefined) return undefined;
  return {
    enabled: legacyEnvOverrideBool(
      "SUPABASE_AUTH_EMAIL_SMTP_ENABLED",
      smtpDoc["enabled"] === undefined ? true : smtpDoc["enabled"] === true,
      "auth.email.smtp.enabled",
      projectEnvValues,
    ),
    host:
      legacyEnvOverride(
        "SUPABASE_AUTH_EMAIL_SMTP_HOST",
        typeof smtpDoc["host"] === "string" ? smtpDoc["host"] : "",
        projectEnvValues,
      ) ?? "",
    port: legacyEnvOverridePort(
      "SUPABASE_AUTH_EMAIL_SMTP_PORT",
      typeof smtpDoc["port"] === "number" ? smtpDoc["port"] : 0,
      "auth.email.smtp.port",
      projectEnvValues,
    ),
    user:
      legacyEnvOverride(
        "SUPABASE_AUTH_EMAIL_SMTP_USER",
        typeof smtpDoc["user"] === "string" ? smtpDoc["user"] : "",
        projectEnvValues,
      ) ?? "",
    // Go's `Auth.Email.Smtp.Pass` is a `config.Secret` (`pkg/config/auth.go:260`),
    // decrypted by `DecryptSecretHookFunc` at decode time for both the TOML
    // value and any env override — same treatment as `jwt_secret`/the API
    // keys below, via the same `legacyDecryptAuthSecret` helper.
    pass:
      legacyDecryptAuthSecret(
        legacyEnvOverride(
          "SUPABASE_AUTH_EMAIL_SMTP_PASS",
          typeof smtpDoc["pass"] === "string" ? smtpDoc["pass"] : "",
          projectEnvValues,
        ) ?? "",
        projectEnvValues,
      ) ?? "",
    adminEmail:
      legacyEnvOverride(
        "SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL",
        typeof smtpDoc["admin_email"] === "string" ? smtpDoc["admin_email"] : "",
        projectEnvValues,
      ) ?? "",
    senderName: legacyEnvOverride(
      "SUPABASE_AUTH_EMAIL_SMTP_SENDER_NAME",
      typeof smtpDoc["sender_name"] === "string" ? smtpDoc["sender_name"] : undefined,
      projectEnvValues,
    ),
  };
}

/**
 * Go's `Config.Validate` checks `auth.captcha` right after `auth.site_url`,
 * still inside `if c.Auth.Enabled` (`pkg/config/config.go:1099-1109`): an
 * enabled CAPTCHA section requires both `provider` and `secret`. `auth.captcha.*`
 * is Viper-bound like every other nested field once `[auth.captcha]` is present
 * in config.toml (`ExperimentalBindStruct`/`AutomaticEnv`, `config.go:581-586`),
 * so `SUPABASE_AUTH_CAPTCHA_ENABLED`/`_PROVIDER`/`_SECRET` overrides apply before
 * this validation runs. Unlike the flat `auth.site_url` field, `config.auth.captcha`
 * does NOT decode to `undefined` when `[auth.captcha]` is absent from config.toml —
 * `captcha.ts`'s own `withDecodingDefaultKey` fills in `{ enabled: false }` even
 * through the outer `Schema.optionalKey` wrapper (`packages/config/src/auth/index.ts`),
 * confirmed empirically; there is no schema-level presence signal here, unlike
 * `auth.passkey`/`auth.webauthn`. So presence is read from the raw `authDocument`
 * instead — matching Go's `AutomaticEnv` (which only intercepts keys already
 * present in the merged config), an absent `[auth.captcha]` section never picks
 * up an env override alone.
 *
 * Hoisted (like {@link legacyResolveAuthEmailSmtp}) so both
 * `legacyResolveLocalConfigValues` (`Config.Validate` parity) and
 * `start.handler.ts`'s `resolveGotrueEnvInput` (the actual GoTrue env) resolve
 * the SAME effective value — `secret` is `Secret`-typed in Go
 * (`pkg/config/auth.go`), decrypted the same way `jwt_secret`/API keys/`smtp.pass` are.
 */
export function legacyResolveAuthCaptcha(
  authDocument: Readonly<Record<string, unknown>> | undefined,
  captcha: ProjectConfig["auth"]["captcha"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): LegacyCaptchaInput | undefined {
  const captchaDoc = asRecord(authDocument?.["captcha"]);
  return captcha
    ? {
        enabled:
          captchaDoc !== undefined
            ? legacyEnvOverrideBool(
                "SUPABASE_AUTH_CAPTCHA_ENABLED",
                captcha.enabled ?? false,
                "auth.captcha.enabled",
                projectEnvValues,
              )
            : (captcha.enabled ?? false),
        provider:
          captchaDoc !== undefined
            ? legacyEnvOverride(
                "SUPABASE_AUTH_CAPTCHA_PROVIDER",
                captcha.provider,
                projectEnvValues,
              )
            : captcha.provider,
        secret: legacyDecryptAuthSecret(
          captchaDoc !== undefined
            ? legacyEnvOverride("SUPABASE_AUTH_CAPTCHA_SECRET", captcha.secret, projectEnvValues)
            : captcha.secret,
          projectEnvValues,
        ),
      }
    : undefined;
}

/** Go's `(a *auth) generateAPIKeys` (`pkg/config/apikeys.go:43-73`). */
function resolveJwtSecret(configured: string | undefined): string {
  if (configured === undefined || configured.length === 0) return defaultJwtSecret;
  if (configured.length < MIN_JWT_SECRET_LENGTH) {
    throw new LegacyInvalidJwtSecretError();
  }
  return configured;
}

function resolveOpaqueKey(configured: string | undefined, fallback: string): string {
  return configured !== undefined && configured.length > 0 ? configured : fallback;
}

function resolveSignedKey(
  configured: string | undefined,
  jwtSecret: string,
  signingKey: LegacyJwk | undefined,
  role: "anon" | "service_role",
): string {
  if (configured !== undefined && configured.length > 0) return configured;
  return signingKey !== undefined
    ? legacyGenerateAsymmetricGoJwt(signingKey, role)
    : legacyGenerateGoJwt(jwtSecret, role);
}

/** Matches Go's `JWK` struct fields (`pkg/config/auth.go:88-108`) — see `LegacyJwk`. */
const LegacyJwkSchema = Schema.Struct({
  kty: Schema.String,
  kid: Schema.optionalKey(Schema.String),
  use: Schema.optionalKey(Schema.String),
  key_ops: Schema.optionalKey(Schema.Array(Schema.String)),
  alg: Schema.optionalKey(Schema.String),
  ext: Schema.optionalKey(Schema.Boolean),
  n: Schema.optionalKey(Schema.String),
  e: Schema.optionalKey(Schema.String),
  d: Schema.optionalKey(Schema.String),
  p: Schema.optionalKey(Schema.String),
  q: Schema.optionalKey(Schema.String),
  dp: Schema.optionalKey(Schema.String),
  dq: Schema.optionalKey(Schema.String),
  qi: Schema.optionalKey(Schema.String),
  crv: Schema.optionalKey(Schema.String),
  x: Schema.optionalKey(Schema.String),
  y: Schema.optionalKey(Schema.String),
});
const decodeLegacyJwks = Schema.decodeUnknownSync(Schema.Array(LegacyJwkSchema));

/**
 * Go's `Config.Validate` (`pkg/config/config.go:877-878,1059-1062`): a relative
 * `signing_keys_path` resolves against `<workdir>/supabase`, then the file is
 * read and JSON-decoded into `[]JWK`. Used via {@link legacyResolveConfiguredSigningKeys}'s
 * {@link loadSigningKeys} call, both by `legacyResolveLocalConfigValues` (which only needs the
 * first key to sign anon/service_role, matching `generateJWT`'s `a.SigningKeys[0]` — see
 * {@link resolveSignedKey}) and {@link legacyResolveLocalJwks} (the full array, matching
 * `ResolveJWKS`'s `a.SigningKeys` loop).
 *
 * Uses `node:fs` directly (not the `FileSystem` Effect service other Go-parity
 * resolvers in `legacy/` use for file reads) so this function — and its large
 * existing test surface — can stay a plain synchronous resolver; this is an
 * optional, rarely-configured field, not worth threading Effect dependencies
 * through `legacyStatusValues`/`status.handler.ts` for.
 *
 * Error wording matches Go's two `Validate` failure branches exactly
 * (`"failed to read signing keys: %w"` for an open failure, `"failed to decode
 * signing keys: %w"` for a parse failure) rather than letting `readFileSync`/
 * `JSON.parse`'s raw Node error text through unwrapped.
 *
 * Callers must only invoke this when auth is enabled (the `SUPABASE_AUTH_ENABLED`-
 * overridden value, not necessarily raw `config.auth.enabled` — see
 * {@link legacyEnvOverrideBool}) — Go's `Validate` nests the entire signing-keys read
 * inside `if c.Auth.Enabled` (`pkg/config/config.go:1036,1059-1065`), reading
 * that same post-override value, so a disabled auth section never touches
 * `signing_keys_path`, however stale or missing that file is.
 */
function readSigningKeysFile(workdir: string, signingKeysPath: string): ReadonlyArray<LegacyJwk> {
  const absolutePath = legacyResolveSigningKeysPath(workdir, signingKeysPath);

  let contents: string;
  try {
    contents = readFileSync(absolutePath, "utf8");
  } catch (cause) {
    throw new LegacyConfigValidateError(legacySigningKeysReadErrorMessage(cause));
  }

  try {
    // `Schema.Array` decodes `key_ops` as `ReadonlyArray<string>`, but `LegacyJwk.key_ops` is a
    // mutable `string[]` (required for assignability into Node's `createPrivateKey`/`JsonWebKey`
    // input — see that type's own doc comment), so each key's `key_ops` is copied into a fresh
    // mutable array here rather than widening the schema's own (correctly readonly) output type.
    return decodeLegacyJwks(JSON.parse(contents)).map((jwk) => ({
      ...jwk,
      key_ops: jwk.key_ops === undefined ? undefined : [...jwk.key_ops],
    }));
  } catch (cause) {
    throw new LegacyConfigValidateError(legacySigningKeysDecodeErrorMessage(cause));
  }
}

/** See {@link readSigningKeysFile}. */
function loadSigningKeys(workdir: string, signingKeysPath: string): ReadonlyArray<LegacyJwk> {
  return readSigningKeysFile(workdir, signingKeysPath);
}

/**
 * Go's `Auth.SigningKeys` config-load gating (`pkg/config/config.go:1087,1110-
 * 1116`): `auth.signing_keys_path`'s file is read only when auth is enabled
 * (the `SUPABASE_AUTH_ENABLED`-overridden value) AND a path is actually
 * configured. Returns `undefined` in every other case — Go's `Auth.SigningKeys`
 * then keeps its `NewConfig()`-seeded single default ES256 key
 * ({@link LEGACY_DEFAULT_SIGNING_KEY}); callers fall back to their own default
 * instead of this function choosing one, since `legacyResolveLocalJwks` and
 * `gotrue.service.ts`'s `GOTRUE_JWT_KEYS` each spell their own default slightly
 * differently (a bare JWKS-shaped key vs. a full `LegacyGotrueSigningKey`).
 *
 * Shared by {@link legacyResolveLocalJwks} (the full JWKS document) and
 * `start.handler.ts`'s `GOTRUE_JWT_KEYS` env (Go's `GOTRUE_JWT_KEYS =
 * utils.Config.Auth.SigningKeys`) so the two resolvers can never disagree on
 * which signing key(s) apply — a prerequisite for GoTrue-issued tokens to
 * verify against the published JWKS at all.
 */
export function legacyResolveConfiguredSigningKeys(
  config: ProjectConfig,
  workdir: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): ReadonlyArray<LegacyJwk> | undefined {
  const authEnabled = legacyEnvOverrideBool(
    "SUPABASE_AUTH_ENABLED",
    config.auth.enabled,
    "auth.enabled",
    projectEnvValues,
  );
  const signingKeysPath = legacyEnvOverride(
    "SUPABASE_AUTH_SIGNING_KEYS_PATH",
    config.auth.signing_keys_path,
    projectEnvValues,
  );
  return authEnabled && signingKeysPath !== undefined && signingKeysPath.length > 0
    ? loadSigningKeys(workdir, signingKeysPath)
    : undefined;
}

/**
 * Go's `Config.Validate` TLS branch (`pkg/config/config.go:1006-1027`) file reads: gated on
 * `api.enabled && api.tls.enabled` same as the caller, each configured path is read to confirm
 * it's actually reachable, matching Go's `fs.ReadFile` calls (Go caches the bytes for `start` to
 * serve as `CertContent`/`KeyContent` — `status`/`stop` have no use for the bytes, only the same
 * validation outcome, so they're discarded here). The "exactly one of cert/key set" presence
 * check now lives in `legacyValidateResolvedConfig`'s `api.tls` step
 * (`legacy-config-validate.ts`) — this function only runs the reads, and only when BOTH paths
 * are actually present: neither path set, or only one, never reaches a `fs.ReadFile` call here,
 * since the presence check (run later, as part of the single consolidated validation call) owns
 * rejecting the one-but-not-the-other case.
 *
 * Go joins both paths unconditionally with the `supabase/` dir — no `filepath.IsAbs` guard
 * (`config.go:961-965` uses `path.Join`, which absorbs a leading `/`) — unlike
 * {@link readSigningKeysFile}'s `signing_keys_path`, which Go does guard with `filepath.IsAbs`
 * (`config.go:928-929`). See `legacyResolveApiTlsPath`. Matches the identical Kong-side
 * validation already ported for `seed buckets`/`storage` in
 * `legacy-storage-credentials.ts`'s `validateLocalKongTls`.
 *
 * Uses `node:fs` directly for the same reason as {@link readSigningKeysFile}: this stays a plain
 * synchronous resolver rather than threading the Effect `FileSystem` service through
 * `legacyStatusValues`/`status.handler.ts`.
 */
function readApiTlsFiles(
  workdir: string,
  certPath: string | undefined,
  keyPath: string | undefined,
): void {
  if (certPath === undefined || certPath.length === 0) return;
  if (keyPath === undefined || keyPath.length === 0) return;

  try {
    readFileSync(legacyResolveApiTlsPath(workdir, certPath), "utf8");
  } catch (cause) {
    throw new LegacyConfigValidateError(legacyApiTlsCertReadErrorMessage(cause));
  }
  try {
    readFileSync(legacyResolveApiTlsPath(workdir, keyPath), "utf8");
  } catch (cause) {
    throw new LegacyConfigValidateError(legacyApiTlsKeyReadErrorMessage(cause));
  }
}

/**
 * One `[auth.email.template.<name>]` entry, already env-override-resolved. `subject` is
 * `string | undefined` rather than a plain `string` — see {@link legacyResolveAuthEmail}'s doc
 * comment for why.
 */
interface LegacyResolvedAuthEmailTemplate {
  readonly subject: string | undefined;
  readonly content_path: string;
}

/** One `[auth.email.notification.<name>]` entry — see {@link LegacyResolvedAuthEmailTemplate}. */
interface LegacyResolvedAuthEmailNotification {
  readonly enabled: boolean;
  readonly subject: string | undefined;
  readonly content_path: string;
}

/**
 * {@link legacyResolveAuthEmail}'s return type — identical to `ProjectConfig["auth"]["email"]`
 * except each `template`/`notification` entry's `subject` is `string | undefined` instead of a
 * plain `string`.
 */
export type LegacyResolvedAuthEmail = Omit<
  ProjectConfig["auth"]["email"],
  "template" | "notification"
> & {
  readonly template: Readonly<Record<string, LegacyResolvedAuthEmailTemplate>>;
  readonly notification: Readonly<Record<string, LegacyResolvedAuthEmailNotification>>;
};

/**
 * Go's `Auth.Email` is a value-typed (non-pointer) struct (`pkg/config/auth.go:174,242-253`),
 * always Viper/`AutomaticEnv`-bound regardless of `[auth.email]` presence in config.toml
 * (`config.go:580-586`) — same reasoning as {@link resolveGotrueRateLimit}/`resolveGotrueSessions`
 * in `start.handler.ts`, just hoisted here since `readAuthEmailTemplateContent`'s validation-only
 * file-read ALSO needs the override-aware `template`/`notification` maps, not just
 * `start.handler.ts`'s GoTrue env builder — same single-source/two-consumer shape as
 * {@link legacyResolveAuthExternalProviders}.
 *
 * `template`/`notification` THEMSELVES need no raw-document presence gate: they're
 * `Schema.Record`s (`packages/config/src/auth/email.ts`), which — unlike a fixed-shape struct
 * with `withDecodingDefaultKey` — only ever contain a key when the TOML section was actually
 * present, so `Object.entries(email.template)` already reflects presence, matching Go's own
 * `map[string]emailTemplate`. Each entry's OWN `subject` field is a narrower case, though: Go's
 * `emailTemplate.Subject` is `*string` (`pkg/config/auth.go:266`), so an explicit `subject = ""`
 * is a real, non-nil state distinct from an absent key — but both decode to the SAME `""` in
 * `@supabase/config`'s plain-string schema (`packages/config/src/auth/email.ts`), so `authDocument`
 * (the raw TOML) is read per-entry to recover which case applies, same as the
 * `auth.captcha`/`auth.passkey`/`auth.webauthn`/`auth.email.smtp` presence gaps elsewhere in this
 * file. An env override always wins outright when set (Go's Viper `AutomaticEnv` precedence over
 * config.toml), regardless of the raw document.
 *
 * `start.go:544-558` (Kong `mountEmailTemplates`) and `start.go:668-694,1376-1406` (GoTrue's
 * mailer/OTP/signup env) both read `utils.Config.Auth.Email.*` post-override — this resolves the
 * SAME effective value for both `buildKongEmailTemplateMounts` and `resolveGotrueEnvInput` in
 * `start.handler.ts`.
 */
export function legacyResolveAuthEmail(
  email: ProjectConfig["auth"]["email"],
  authDocument: Record<string, unknown> | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): LegacyResolvedAuthEmail {
  const emailDoc = asRecord(authDocument?.["email"]);
  const templateDoc = asRecord(emailDoc?.["template"]);
  const notificationDoc = asRecord(emailDoc?.["notification"]);

  const template: Record<string, LegacyResolvedAuthEmailTemplate> = {};
  for (const [name, tmpl] of Object.entries(email.template)) {
    const envPrefix = `SUPABASE_AUTH_EMAIL_TEMPLATE_${name.toUpperCase()}`;
    const envSubject = legacyEnvOverride(`${envPrefix}_SUBJECT`, undefined, projectEnvValues);
    const rawSubjectPresent = asRecord(templateDoc?.[name])?.["subject"] !== undefined;
    template[name] = {
      subject: envSubject ?? (rawSubjectPresent ? tmpl.subject : undefined),
      content_path:
        legacyEnvOverride(`${envPrefix}_CONTENT_PATH`, tmpl.content_path, projectEnvValues) ??
        tmpl.content_path,
    };
  }

  const notification: Record<string, LegacyResolvedAuthEmailNotification> = {};
  for (const [name, tmpl] of Object.entries(email.notification)) {
    const envPrefix = `SUPABASE_AUTH_EMAIL_NOTIFICATION_${name.toUpperCase()}`;
    const envSubject = legacyEnvOverride(`${envPrefix}_SUBJECT`, undefined, projectEnvValues);
    const rawSubjectPresent = asRecord(notificationDoc?.[name])?.["subject"] !== undefined;
    notification[name] = {
      enabled: legacyEnvOverrideBool(
        `${envPrefix}_ENABLED`,
        tmpl.enabled,
        `auth.email.notification.${name}.enabled`,
        projectEnvValues,
      ),
      subject: envSubject ?? (rawSubjectPresent ? tmpl.subject : undefined),
      content_path:
        legacyEnvOverride(`${envPrefix}_CONTENT_PATH`, tmpl.content_path, projectEnvValues) ??
        tmpl.content_path,
    };
  }

  return {
    ...email,
    enable_signup: legacyEnvOverrideBool(
      "SUPABASE_AUTH_EMAIL_ENABLE_SIGNUP",
      email.enable_signup,
      "auth.email.enable_signup",
      projectEnvValues,
    ),
    double_confirm_changes: legacyEnvOverrideBool(
      "SUPABASE_AUTH_EMAIL_DOUBLE_CONFIRM_CHANGES",
      email.double_confirm_changes,
      "auth.email.double_confirm_changes",
      projectEnvValues,
    ),
    enable_confirmations: legacyEnvOverrideBool(
      "SUPABASE_AUTH_EMAIL_ENABLE_CONFIRMATIONS",
      email.enable_confirmations,
      "auth.email.enable_confirmations",
      projectEnvValues,
    ),
    secure_password_change: legacyEnvOverrideBool(
      "SUPABASE_AUTH_EMAIL_SECURE_PASSWORD_CHANGE",
      email.secure_password_change,
      "auth.email.secure_password_change",
      projectEnvValues,
    ),
    max_frequency:
      legacyEnvOverride(
        "SUPABASE_AUTH_EMAIL_MAX_FREQUENCY",
        email.max_frequency,
        projectEnvValues,
      ) ?? email.max_frequency,
    otp_length: legacyEnvOverrideUint(
      "SUPABASE_AUTH_EMAIL_OTP_LENGTH",
      "auth.email.otp_length",
      email.otp_length,
      projectEnvValues,
    ),
    otp_expiry: legacyEnvOverrideUint(
      "SUPABASE_AUTH_EMAIL_OTP_EXPIRY",
      "auth.email.otp_expiry",
      email.otp_expiry,
      projectEnvValues,
    ),
    template,
    notification,
  };
}

/**
 * Go's `(e *email) validate(fsys)` template/notification content read (`pkg/config/
 * config.go:1293-1313`), called from `Config.Validate` right after `Auth.MFA.validate()`, still
 * inside `if c.Auth.Enabled` (`config.go:1142`). Every template is checked unconditionally; a
 * notification only when that notification is itself enabled (`config.go:1308`). Uses the same
 * `readFileSync`-based pattern as {@link readSigningKeysFile}/`readApiTlsFiles` in this file,
 * not an Effect `FileSystem` service.
 *
 * The `content`-vs-`content_path` exclusivity decision and path resolution (including the
 * TEMPLATE-vs-`workdir`/NOTIFICATION-vs-`<workdir>/supabase` base asymmetry, per Go's `(c
 * *baseConfig) resolve` (`config.go:900-916`) — this asymmetry is real, intentional Go behavior
 * to match, not a bug to fix) now live in `legacyResolveEmailTemplateContentPath`
 * (`legacy-config-validate.ts`); this function only feeds it `contentPresent` (computed from the
 * raw `document`, since `@supabase/config`'s `template`/`notification` schema
 * (`packages/config/src/auth/email.ts`) has no `content` field to see) and performs the read
 * when a path comes back.
 *
 * Takes the ALREADY env-override-resolved `email` (from {@link legacyResolveAuthEmail}) so this
 * only performs the file-existence read, matching the other validators' "resolve once, validate
 * the resolved value" shape.
 */
function readAuthEmailTemplateContent(
  email: LegacyResolvedAuthEmail,
  workdir: string,
  authDocument: Record<string, unknown> | undefined,
): void {
  const emailDoc = asRecord(authDocument?.["email"]);
  const templatesDoc = asRecord(emailDoc?.["template"]);
  const notificationsDoc = asRecord(emailDoc?.["notification"]);

  for (const [name, tmpl] of Object.entries(email.template)) {
    const path = legacyResolveEmailTemplateContentPath({
      section: "template",
      name,
      contentPath: tmpl.content_path,
      contentPresent: asRecord(templatesDoc?.[name])?.["content"] !== undefined,
      base: workdir,
    });
    if (path === undefined) continue;
    try {
      readFileSync(path, "utf8");
    } catch (cause) {
      throw new LegacyConfigValidateError(
        legacyEmailContentPathReadErrorMessage("template", name, cause),
      );
    }
  }
  for (const [name, tmpl] of Object.entries(email.notification)) {
    if (!tmpl.enabled) continue;
    const path = legacyResolveEmailTemplateContentPath({
      section: "notification",
      name,
      contentPath: tmpl.content_path,
      contentPresent: asRecord(notificationsDoc?.[name])?.["content"] !== undefined,
      base: join(workdir, "supabase"),
    });
    if (path === undefined) continue;
    try {
      readFileSync(path, "utf8");
    } catch (cause) {
      throw new LegacyConfigValidateError(
        legacyEmailContentPathReadErrorMessage("notification", name, cause),
      );
    }
  }
}

/**
 * `SUPABASE_<NAME>` sibling of {@link legacyEnvOverridePort} for `uint`-typed config
 * fields with no upper-bound cap (`db.major_version`, `edge_runtime.
 * deno_version`, `auth.jwt_expiry`, `auth.refresh_token_reuse_interval`,
 * `auth.minimum_password_length`, …) — same generic Viper `AutomaticEnv`
 * binding (`config.go:576-586`), same mapstructure hard-fail-on-bad-value
 * semantics as the capped `uint16` port fields, but without `MAX_PORT`. A
 * non-digit override folds into the same generic "Invalid <field>" message
 * `legacyValidateResolvedConfig` produces for an out-of-set numeric value,
 * since Go's own decode failure and `Validate` failure for these fields
 * aren't independently distinguishable from the CLI's output the way
 * ports/bools are.
 */
export function legacyEnvOverrideUint(
  name: string,
  dottedFieldPath: string,
  configured: number,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  const value = legacyEnvOverride(name, undefined, projectEnvValues);
  if (value === undefined) return configured;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Failed reading config: Invalid ${dottedFieldPath}: ${value}.`);
  }
  return Number(value);
}

/** `SUPABASE_DB_MAJOR_VERSION` — see {@link legacyEnvOverrideUint}. */
export function legacyEnvOverrideMajorVersion(
  configured: number,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  return legacyEnvOverrideUint(
    "SUPABASE_DB_MAJOR_VERSION",
    "db.major_version",
    configured,
    projectEnvValues,
  );
}

/** `SUPABASE_EDGE_RUNTIME_DENO_VERSION` — see {@link legacyEnvOverrideUint}. */
export function legacyEnvOverrideDenoVersion(
  configured: number,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  return legacyEnvOverrideUint(
    "SUPABASE_EDGE_RUNTIME_DENO_VERSION",
    "edge_runtime.deno_version",
    configured,
    projectEnvValues,
  );
}

/**
 * Optional-uint sibling of {@link legacyEnvOverrideUint} for `db.settings.*` number
 * fields (`max_connections`, `max_wal_senders`, …) — each one is a genuine Go
 * nil pointer (`*uint`) when unset in `config.toml`, unlike `db.major_version`/
 * `edge_runtime.deno_version`, which always have a real default. `configured`
 * (and the return value) stay `number | undefined` to preserve that
 * "not configured" state through an override miss, matching Go's nil pointer
 * staying nil when no `SUPABASE_DB_SETTINGS_*` override is set either.
 */
function envOverrideOptionalUint(
  name: string,
  dottedFieldPath: string,
  configured: number | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number | undefined {
  const value = legacyEnvOverride(name, undefined, projectEnvValues);
  if (value === undefined) return configured;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Failed reading config: Invalid ${dottedFieldPath}: ${value}.`);
  }
  return Number(value);
}

/**
 * Optional-bool sibling of {@link legacyEnvOverrideBool} for
 * `db.settings.track_commit_timestamp` — a genuine Go nil pointer (`*bool`)
 * when unset, unlike every other bool this file overrides (all of which have
 * a real default and can never be "not configured").
 */
function legacyEnvOverrideOptionalBool(
  name: string,
  configured: boolean | undefined,
  dottedFieldPath: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): boolean | undefined {
  const value = legacyEnvOverride(name, undefined, projectEnvValues);
  if (value === undefined) return configured;
  const parsed = legacyParseGoBool(value);
  if (parsed === undefined) {
    throw new LegacyInvalidBoolEnvOverrideError(dottedFieldPath, value);
  }
  return parsed;
}

/**
 * Thrown by {@link legacyResolveDbSettingsEnvOverrides} when
 * `SUPABASE_DB_SETTINGS_SESSION_REPLICATION_ROLE` doesn't match Go's
 * `SessionReplicationRole` (`pkg/config/db.go:29-43`) — `UnmarshalText`
 * hard-rejects anything outside `{origin, replica, local}`, same mechanism as
 * {@link LegacyInvalidAnalyticsBackendEnvOverrideError}/
 * {@link LegacyInvalidRealtimeIpVersionEnvOverrideError}.
 */
export class LegacyInvalidSessionReplicationRoleEnvOverrideError extends Error {
  constructor(dottedFieldPath: string, value: string) {
    super(
      `Invalid config for ${dottedFieldPath}: cannot parse "${value}" as one of "origin", "replica", "local"`,
    );
    this.name = "LegacyInvalidSessionReplicationRoleEnvOverrideError";
  }
}

/**
 * `db.settings.session_replication_role`-flavored sibling of
 * {@link envOverrideAnalyticsBackend}/{@link legacyEnvOverrideRealtimeIpVersion}
 * — the one `db.settings.*` field Go decodes as a text-unmarshalled enum
 * rather than a string/number/bool. Unlike those two siblings, `configured`
 * (and the return value) may genuinely be `undefined` (Go's nil pointer, "not
 * configured" — never written to `postgresql.conf`), so validation only runs
 * once the merged override-or-configured value is actually present.
 */
function legacyEnvOverrideSessionReplicationRole(
  configured: string | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): "origin" | "replica" | "local" | undefined {
  const value = legacyEnvOverride(
    "SUPABASE_DB_SETTINGS_SESSION_REPLICATION_ROLE",
    configured,
    projectEnvValues,
  );
  if (value === undefined) return undefined;
  if (value !== "origin" && value !== "replica" && value !== "local") {
    throw new LegacyInvalidSessionReplicationRoleEnvOverrideError(
      "db.settings.session_replication_role",
      value,
    );
  }
  return value;
}

/**
 * Go's `Config.Load` applies every `SUPABASE_DB_SETTINGS_*` override
 * generically (Viper's `AutomaticEnv`, `pkg/config/config.go:576-586`) before
 * `(a *settings) ToPostgresConfig()` (`pkg/config/db.go:181-190`) ever
 * serializes `db.settings` into `postgresql.conf` — so an override for, say,
 * `shared_buffers` changes what Go actually configures Postgres with. This
 * resolves all 23 `db.settings.*` sub-fields (`packages/config/src/db.ts`) to
 * their env-overridden value, for `legacyPostgresSettingsToPostgresConfig` to
 * serialize — mirroring the `db.port`/`db.major_version`-style fix already
 * applied at this same `start` call site, just fanned out across every
 * `[db.settings]` field instead of one.
 */
export function legacyResolveDbSettingsEnvOverrides(
  settings: ProjectConfig["db"]["settings"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): NonNullable<ProjectConfig["db"]["settings"]> {
  return {
    effective_cache_size: legacyEnvOverride(
      "SUPABASE_DB_SETTINGS_EFFECTIVE_CACHE_SIZE",
      settings?.effective_cache_size,
      projectEnvValues,
    ),
    logical_decoding_work_mem: legacyEnvOverride(
      "SUPABASE_DB_SETTINGS_LOGICAL_DECODING_WORK_MEM",
      settings?.logical_decoding_work_mem,
      projectEnvValues,
    ),
    maintenance_work_mem: legacyEnvOverride(
      "SUPABASE_DB_SETTINGS_MAINTENANCE_WORK_MEM",
      settings?.maintenance_work_mem,
      projectEnvValues,
    ),
    max_connections: envOverrideOptionalUint(
      "SUPABASE_DB_SETTINGS_MAX_CONNECTIONS",
      "db.settings.max_connections",
      settings?.max_connections,
      projectEnvValues,
    ),
    max_locks_per_transaction: envOverrideOptionalUint(
      "SUPABASE_DB_SETTINGS_MAX_LOCKS_PER_TRANSACTION",
      "db.settings.max_locks_per_transaction",
      settings?.max_locks_per_transaction,
      projectEnvValues,
    ),
    max_parallel_maintenance_workers: envOverrideOptionalUint(
      "SUPABASE_DB_SETTINGS_MAX_PARALLEL_MAINTENANCE_WORKERS",
      "db.settings.max_parallel_maintenance_workers",
      settings?.max_parallel_maintenance_workers,
      projectEnvValues,
    ),
    max_parallel_workers: envOverrideOptionalUint(
      "SUPABASE_DB_SETTINGS_MAX_PARALLEL_WORKERS",
      "db.settings.max_parallel_workers",
      settings?.max_parallel_workers,
      projectEnvValues,
    ),
    max_parallel_workers_per_gather: envOverrideOptionalUint(
      "SUPABASE_DB_SETTINGS_MAX_PARALLEL_WORKERS_PER_GATHER",
      "db.settings.max_parallel_workers_per_gather",
      settings?.max_parallel_workers_per_gather,
      projectEnvValues,
    ),
    max_replication_slots: envOverrideOptionalUint(
      "SUPABASE_DB_SETTINGS_MAX_REPLICATION_SLOTS",
      "db.settings.max_replication_slots",
      settings?.max_replication_slots,
      projectEnvValues,
    ),
    max_slot_wal_keep_size: legacyEnvOverride(
      "SUPABASE_DB_SETTINGS_MAX_SLOT_WAL_KEEP_SIZE",
      settings?.max_slot_wal_keep_size,
      projectEnvValues,
    ),
    max_standby_archive_delay: legacyEnvOverride(
      "SUPABASE_DB_SETTINGS_MAX_STANDBY_ARCHIVE_DELAY",
      settings?.max_standby_archive_delay,
      projectEnvValues,
    ),
    max_standby_streaming_delay: legacyEnvOverride(
      "SUPABASE_DB_SETTINGS_MAX_STANDBY_STREAMING_DELAY",
      settings?.max_standby_streaming_delay,
      projectEnvValues,
    ),
    max_wal_size: legacyEnvOverride(
      "SUPABASE_DB_SETTINGS_MAX_WAL_SIZE",
      settings?.max_wal_size,
      projectEnvValues,
    ),
    max_wal_senders: envOverrideOptionalUint(
      "SUPABASE_DB_SETTINGS_MAX_WAL_SENDERS",
      "db.settings.max_wal_senders",
      settings?.max_wal_senders,
      projectEnvValues,
    ),
    max_worker_processes: envOverrideOptionalUint(
      "SUPABASE_DB_SETTINGS_MAX_WORKER_PROCESSES",
      "db.settings.max_worker_processes",
      settings?.max_worker_processes,
      projectEnvValues,
    ),
    session_replication_role: legacyEnvOverrideSessionReplicationRole(
      settings?.session_replication_role,
      projectEnvValues,
    ),
    shared_buffers: legacyEnvOverride(
      "SUPABASE_DB_SETTINGS_SHARED_BUFFERS",
      settings?.shared_buffers,
      projectEnvValues,
    ),
    statement_timeout: legacyEnvOverride(
      "SUPABASE_DB_SETTINGS_STATEMENT_TIMEOUT",
      settings?.statement_timeout,
      projectEnvValues,
    ),
    track_activity_query_size: legacyEnvOverride(
      "SUPABASE_DB_SETTINGS_TRACK_ACTIVITY_QUERY_SIZE",
      settings?.track_activity_query_size,
      projectEnvValues,
    ),
    track_commit_timestamp: legacyEnvOverrideOptionalBool(
      "SUPABASE_DB_SETTINGS_TRACK_COMMIT_TIMESTAMP",
      settings?.track_commit_timestamp,
      "db.settings.track_commit_timestamp",
      projectEnvValues,
    ),
    wal_keep_size: legacyEnvOverride(
      "SUPABASE_DB_SETTINGS_WAL_KEEP_SIZE",
      settings?.wal_keep_size,
      projectEnvValues,
    ),
    wal_sender_timeout: legacyEnvOverride(
      "SUPABASE_DB_SETTINGS_WAL_SENDER_TIMEOUT",
      settings?.wal_sender_timeout,
      projectEnvValues,
    ),
    work_mem: legacyEnvOverride(
      "SUPABASE_DB_SETTINGS_WORK_MEM",
      settings?.work_mem,
      projectEnvValues,
    ),
  };
}

/** Go's `password_requirements` fixed enum (`@supabase/config`'s `packages/config/src/auth/index.ts`). */
const LEGACY_PASSWORD_REQUIREMENTS_VALUES = new Set([
  "",
  "letters_digits",
  "lower_upper_letters_digits",
  "lower_upper_letters_digits_symbols",
]);

/** Narrows an unknown value to a plain object, mirroring `legacy-db-config.toml-read.ts`'s `asRecord`. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Go's `hook.validate()` hook-type iteration order (`pkg/config/config.go:1453-1485`), used
 * only to build {@link legacyResolveLocalConfigValues}'s `hooks` input in the right order —
 * the actual per-hook validation now lives in `legacyValidateResolvedConfig`. */
const LEGACY_HOOK_TYPE_ORDER = [
  "mfa_verification_attempt",
  "password_verification_attempt",
  "custom_access_token",
  "send_sms",
  "send_email",
  "before_user_created",
] as const;

/** camelCase key {@link legacyResolveAuthHooks} exposes per {@link LEGACY_HOOK_TYPE_ORDER} entry — matches `LegacyBuildGotrueEnvInput.hooks`'s field names (`gotrue.service.ts`). */
const LEGACY_HOOK_TYPE_TO_CAMEL = {
  mfa_verification_attempt: "mfaVerificationAttempt",
  password_verification_attempt: "passwordVerificationAttempt",
  custom_access_token: "customAccessToken",
  send_sms: "sendSms",
  send_email: "sendEmail",
  before_user_created: "beforeUserCreated",
} as const satisfies Record<(typeof LEGACY_HOOK_TYPE_ORDER)[number], string>;

interface LegacyResolvedAuthHook {
  readonly enabled: boolean;
  readonly uri: string;
  readonly secrets: string;
}

export type LegacyResolvedAuthHooks = {
  readonly [K in (typeof LEGACY_HOOK_TYPE_TO_CAMEL)[keyof typeof LEGACY_HOOK_TYPE_TO_CAMEL]]: LegacyResolvedAuthHook;
};

/**
 * Go's `hook.validate()` fixed iteration order (`pkg/config/config.go:1453-1485`).
 * `auth.hook.<type>.*` is Viper-bound like every other nested field
 * (`ExperimentalBindStruct`/`AutomaticEnv`, `config.go:581-586`), so
 * `SUPABASE_AUTH_HOOK_<TYPE>_ENABLED`/`_URI`/`_SECRETS` overrides apply before
 * Go builds `GOTRUE_HOOK_*` (`internal/start/start.go:746-792`) — Go has no
 * separate "raw" vs. "effective" hook value, so a hook enabled/retargeted
 * purely through env vars must reach GoTrue too, not just validation.
 * `@supabase/config`'s hook schema always decodes a `{ enabled: false }`
 * default per type regardless of file presence (`packages/config/src/auth/
 * hooks.ts`'s `withDecodingDefaultKey`), which erases the presence signal
 * Go's `AutomaticEnv` needs (it only intercepts keys already present in the
 * merged config) — so, like the passkey/webauthn/captcha overrides, this
 * reads the raw `[auth.hook.<type>]` document to gate the override on the
 * section actually being present.
 *
 * Hoisted (like {@link legacyResolveAuthEmailSmtp}/{@link legacyResolveAuthCaptcha})
 * so both `legacyResolveLocalConfigValues` (which derives its filtered,
 * enabled-only `LegacyHookInput[]` for `Config.Validate` parity from this same
 * unfiltered result) and `start.handler.ts`'s `resolveGotrueEnvInput` (the
 * actual GoTrue env) resolve the SAME effective values.
 */
export function legacyResolveAuthHooks(
  authDocument: Readonly<Record<string, unknown>> | undefined,
  hook: ProjectConfig["auth"]["hook"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): LegacyResolvedAuthHooks {
  const hookDocument = asRecord(authDocument?.["hook"]);
  const result = {} as Record<string, LegacyResolvedAuthHook>;
  for (const hookType of LEGACY_HOOK_TYPE_ORDER) {
    const h = hook[hookType];
    const hookSectionPresent = asRecord(hookDocument?.[hookType]) !== undefined;
    const envPrefix = `SUPABASE_AUTH_HOOK_${hookType.toUpperCase()}`;
    const enabled = hookSectionPresent
      ? legacyEnvOverrideBool(
          `${envPrefix}_ENABLED`,
          h.enabled,
          `auth.hook.${hookType}.enabled`,
          projectEnvValues,
        )
      : h.enabled;
    const uri =
      (hookSectionPresent
        ? legacyEnvOverride(`${envPrefix}_URI`, h.uri, projectEnvValues)
        : h.uri) ?? "";
    const secrets =
      (hookSectionPresent
        ? legacyEnvOverride(`${envPrefix}_SECRETS`, h.secrets, projectEnvValues)
        : h.secrets) ?? "";
    result[LEGACY_HOOK_TYPE_TO_CAMEL[hookType]] = { enabled, uri, secrets };
  }
  return result as LegacyResolvedAuthHooks;
}

/**
 * Go's `Auth.MFA` factor fields (`TOTP`/`Phone`/`WebAuthn`) are value-typed
 * structs (`pkg/config/auth.go:317-321`), never `nil` — unlike `Auth.Hook`'s
 * pointer-typed fields above, Viper's `AutomaticEnv` always binds to them
 * regardless of whether `[auth.mfa.<factor>]` is present in config.toml, so
 * `SUPABASE_AUTH_MFA_*` overrides always apply before `Auth.MFA.validate()`
 * runs (`config.go:1523-1534`) — no raw-document presence gate needed, unlike
 * hooks/smtp above.
 *
 * Hoisted (like {@link legacyResolveAuthHooks}/{@link legacyResolveAuthCaptcha})
 * so both `legacyResolveLocalConfigValues` (which derives its `enrollEnabled`/
 * `verifyEnabled` pairs for `Config.Validate` parity from this same unfiltered
 * result) and `start.handler.ts`'s `resolveGotrueEnvInput` (the actual GoTrue
 * env) resolve the SAME effective values.
 */
export function legacyResolveAuthMfa(
  mfa: ProjectConfig["auth"]["mfa"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): ProjectConfig["auth"]["mfa"] {
  return {
    totp: {
      enroll_enabled: legacyEnvOverrideBool(
        "SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED",
        mfa.totp.enroll_enabled,
        "auth.mfa.totp.enroll_enabled",
        projectEnvValues,
      ),
      verify_enabled: legacyEnvOverrideBool(
        "SUPABASE_AUTH_MFA_TOTP_VERIFY_ENABLED",
        mfa.totp.verify_enabled,
        "auth.mfa.totp.verify_enabled",
        projectEnvValues,
      ),
    },
    phone: {
      enroll_enabled: legacyEnvOverrideBool(
        "SUPABASE_AUTH_MFA_PHONE_ENROLL_ENABLED",
        mfa.phone.enroll_enabled,
        "auth.mfa.phone.enroll_enabled",
        projectEnvValues,
      ),
      verify_enabled: legacyEnvOverrideBool(
        "SUPABASE_AUTH_MFA_PHONE_VERIFY_ENABLED",
        mfa.phone.verify_enabled,
        "auth.mfa.phone.verify_enabled",
        projectEnvValues,
      ),
      otp_length: legacyEnvOverrideUint(
        "SUPABASE_AUTH_MFA_PHONE_OTP_LENGTH",
        "auth.mfa.phone.otp_length",
        mfa.phone.otp_length,
        projectEnvValues,
      ),
      template:
        legacyEnvOverride(
          "SUPABASE_AUTH_MFA_PHONE_TEMPLATE",
          mfa.phone.template,
          projectEnvValues,
        ) ?? mfa.phone.template,
      max_frequency:
        legacyEnvOverride(
          "SUPABASE_AUTH_MFA_PHONE_MAX_FREQUENCY",
          mfa.phone.max_frequency,
          projectEnvValues,
        ) ?? mfa.phone.max_frequency,
    },
    web_authn: {
      enroll_enabled: legacyEnvOverrideBool(
        "SUPABASE_AUTH_MFA_WEB_AUTHN_ENROLL_ENABLED",
        mfa.web_authn.enroll_enabled,
        "auth.mfa.web_authn.enroll_enabled",
        projectEnvValues,
      ),
      verify_enabled: legacyEnvOverrideBool(
        "SUPABASE_AUTH_MFA_WEB_AUTHN_VERIFY_ENABLED",
        mfa.web_authn.verify_enabled,
        "auth.mfa.web_authn.verify_enabled",
        projectEnvValues,
      ),
    },
    max_enrolled_factors: legacyEnvOverrideUint(
      "SUPABASE_AUTH_MFA_MAX_ENROLLED_FACTORS",
      "auth.mfa.max_enrolled_factors",
      mfa.max_enrolled_factors,
      projectEnvValues,
    ),
  };
}

/** Go's `(s *sms) validate()` fixed provider priority (`pkg/config/config.go:1348-1410`) — a
 * `switch` that validates ONLY the first enabled provider in this order. */
const LEGACY_SMS_PROVIDER_ORDER = [
  "twilio",
  "twilio_verify",
  "messagebird",
  "textlocal",
  "vonage",
] as const;

/**
 * Go's `Auth.Sms.<provider>.*` is Viper-bound like every other nested field once
 * `[auth.sms.<provider>]` is present in config.toml (`ExperimentalBindStruct`/`AutomaticEnv`,
 * `config.go:581-586`), so `SUPABASE_AUTH_SMS_<PROVIDER>_ENABLED`/`_<FIELD>` overrides must reach
 * GoTrue's actual container env (`start.go:696-733`), not just `Config.Validate` — same
 * "validates but doesn't use" gap already fixed for `auth.hook`/`auth.captcha`/`auth.external`/
 * `auth.mfa`. Hoisted so both {@link validateAuthSmsProviders} and `start.handler.ts`'s
 * `resolveGotrueEnvInput` resolve the SAME effective per-provider values — same precedent as
 * {@link legacyResolveAuthExternalProviders}.
 *
 * Presence-gated per provider (the raw `[auth.sms.<provider>]` table must exist), matching
 * `AutomaticEnv`'s "only intercepts keys already present in the merged config" behavior — same
 * gate {@link validateAuthSmsProviders} used before this was hoisted out of it. When a provider's
 * table is absent, its decoded (schema-default) values pass through unchanged, still decrypting
 * the one `config.Secret`-typed field per provider (`pkg/config/auth.go:339,345,351,358`) for
 * parity with this function's (now-superseded) `resolveGotrueSms` precursor, which decrypted all
 * 5 providers unconditionally.
 *
 * The 4 top-level scalars (`enable_signup`/`enable_confirmations`/`template`/`max_frequency`,
 * `pkg/config/auth.go:277-288`) get NO presence gate, unlike the providers above — they're
 * unconditionally emitted (uncommented) in Go's ejected default config.toml
 * (`pkg/config/templates/config.toml:257-265`), so `mergeDefaultValues` always registers them
 * with Viper regardless of whether the user's own config.toml even has an `[auth.sms]` section,
 * same reasoning already applied to `legacyResolveAuthEmail`'s scalars. `test_otp` (a
 * `map[string]string`) is deliberately left unresolved: it's commented out of Go's default
 * template, so Viper never knows the key by default, and Go has no `SUPABASE_AUTH_SMS_TEST_OTP*`
 * env var at all — `ExperimentalBindStruct` binds static struct fields, not arbitrary map keys.
 */
export function legacyResolveAuthSms(
  authDocument: Readonly<Record<string, unknown>> | undefined,
  sms: ProjectConfig["auth"]["sms"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): ProjectConfig["auth"]["sms"] {
  const smsDoc = asRecord(authDocument?.["sms"]);

  function providerPresent(providerName: (typeof LEGACY_SMS_PROVIDER_ORDER)[number]): boolean {
    return smsDoc !== undefined && asRecord(smsDoc[providerName]) !== undefined;
  }

  function resolveEnabled(
    providerName: (typeof LEGACY_SMS_PROVIDER_ORDER)[number],
    configured: boolean,
  ): boolean {
    if (!providerPresent(providerName)) return configured;
    return legacyEnvOverrideBool(
      `SUPABASE_AUTH_SMS_${providerName.toUpperCase()}_ENABLED`,
      configured,
      `auth.sms.${providerName}.enabled`,
      projectEnvValues,
    );
  }

  function resolveField(
    providerName: (typeof LEGACY_SMS_PROVIDER_ORDER)[number],
    field: string,
    configured: string | undefined,
  ): string | undefined {
    if (!providerPresent(providerName)) return configured;
    return legacyEnvOverride(
      `SUPABASE_AUTH_SMS_${providerName.toUpperCase()}_${field.toUpperCase()}`,
      configured,
      projectEnvValues,
    );
  }

  return {
    ...sms,
    enable_signup: legacyEnvOverrideBool(
      "SUPABASE_AUTH_SMS_ENABLE_SIGNUP",
      sms.enable_signup,
      "auth.sms.enable_signup",
      projectEnvValues,
    ),
    enable_confirmations: legacyEnvOverrideBool(
      "SUPABASE_AUTH_SMS_ENABLE_CONFIRMATIONS",
      sms.enable_confirmations,
      "auth.sms.enable_confirmations",
      projectEnvValues,
    ),
    template:
      legacyEnvOverride("SUPABASE_AUTH_SMS_TEMPLATE", sms.template, projectEnvValues) ??
      sms.template,
    max_frequency:
      legacyEnvOverride("SUPABASE_AUTH_SMS_MAX_FREQUENCY", sms.max_frequency, projectEnvValues) ??
      sms.max_frequency,
    twilio: {
      enabled: resolveEnabled("twilio", sms.twilio.enabled),
      account_sid: resolveField("twilio", "account_sid", sms.twilio.account_sid) ?? "",
      message_service_sid:
        resolveField("twilio", "message_service_sid", sms.twilio.message_service_sid) ?? "",
      auth_token: legacyDecryptAuthSecret(
        resolveField("twilio", "auth_token", sms.twilio.auth_token),
        projectEnvValues,
      ),
    },
    twilio_verify: {
      enabled: resolveEnabled("twilio_verify", sms.twilio_verify.enabled),
      account_sid: resolveField("twilio_verify", "account_sid", sms.twilio_verify.account_sid),
      message_service_sid: resolveField(
        "twilio_verify",
        "message_service_sid",
        sms.twilio_verify.message_service_sid,
      ),
      auth_token: legacyDecryptAuthSecret(
        resolveField("twilio_verify", "auth_token", sms.twilio_verify.auth_token),
        projectEnvValues,
      ),
    },
    messagebird: {
      enabled: resolveEnabled("messagebird", sms.messagebird.enabled),
      originator: resolveField("messagebird", "originator", sms.messagebird.originator),
      access_key: legacyDecryptAuthSecret(
        resolveField("messagebird", "access_key", sms.messagebird.access_key),
        projectEnvValues,
      ),
    },
    textlocal: {
      enabled: resolveEnabled("textlocal", sms.textlocal.enabled),
      sender: resolveField("textlocal", "sender", sms.textlocal.sender),
      api_key: legacyDecryptAuthSecret(
        resolveField("textlocal", "api_key", sms.textlocal.api_key),
        projectEnvValues,
      ),
    },
    vonage: {
      enabled: resolveEnabled("vonage", sms.vonage.enabled),
      from: resolveField("vonage", "from", sms.vonage.from),
      api_key: resolveField("vonage", "api_key", sms.vonage.api_key),
      api_secret: legacyDecryptAuthSecret(
        resolveField("vonage", "api_secret", sms.vonage.api_secret),
        projectEnvValues,
      ),
    },
  };
}

/**
 * Go's `(s *sms) validate()` (`pkg/config/config.go:1348-1410`): a boolean `switch` that inspects
 * providers in the FIXED priority order above and validates ONLY the first one whose `enabled` is
 * true — a later enabled-but-incomplete provider is never even looked at. Runs against
 * {@link legacyResolveAuthSms}'s env-override-aware result, same document-based, post-override
 * pattern as {@link validateAuthExternalProviders} below.
 */
function validateAuthSmsProviders(
  authDocument: Record<string, unknown> | undefined,
  sms: ProjectConfig["auth"]["sms"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): void {
  const resolved = legacyResolveAuthSms(authDocument, sms, projectEnvValues);

  function requireField(provider: string, field: string, value: string | undefined): void {
    if (value === undefined || value.length === 0) {
      throw new LegacyConfigValidateError(
        `Missing required field in config: auth.sms.${provider}.${field}`,
      );
    }
  }

  if (resolved.twilio.enabled) {
    requireField("twilio", "account_sid", resolved.twilio.account_sid);
    requireField("twilio", "message_service_sid", resolved.twilio.message_service_sid);
    requireField("twilio", "auth_token", resolved.twilio.auth_token);
    return;
  }
  if (resolved.twilio_verify.enabled) {
    requireField("twilio_verify", "account_sid", resolved.twilio_verify.account_sid);
    requireField(
      "twilio_verify",
      "message_service_sid",
      resolved.twilio_verify.message_service_sid,
    );
    requireField("twilio_verify", "auth_token", resolved.twilio_verify.auth_token);
    return;
  }
  if (resolved.messagebird.enabled) {
    requireField("messagebird", "originator", resolved.messagebird.originator);
    requireField("messagebird", "access_key", resolved.messagebird.access_key);
    return;
  }
  if (resolved.textlocal.enabled) {
    requireField("textlocal", "sender", resolved.textlocal.sender);
    requireField("textlocal", "api_key", resolved.textlocal.api_key);
    return;
  }
  if (resolved.vonage.enabled) {
    requireField("vonage", "from", resolved.vonage.from);
    requireField("vonage", "api_key", resolved.vonage.api_key);
    requireField("vonage", "api_secret", resolved.vonage.api_secret);
    return;
  }
}

/** Go's `external.validate()` deprecated-provider skip (`config.go:1419-1423`) — `linkedin`/
 * `slack` are deleted (and warned on, if enabled) before the required-field loop runs, so they
 * are never validated here. Mirrors `legacy-db-config.toml-read.ts`'s identical "B5: external
 * providers" skip list. */
const LEGACY_DEPRECATED_EXTERNAL_PROVIDERS = new Set(["linkedin", "slack"]);

/** Matches `LegacyGotrueExternalProviderInput` (`start/services/gotrue.service.ts`) field-for-field — kept as its own type here rather than importing that command-specific one, same precedent as {@link LegacyResolvedAuthHooks}. */
export interface LegacyResolvedAuthExternalProvider {
  readonly enabled: boolean;
  readonly clientId: string;
  readonly secret?: string;
  readonly url: string;
  readonly redirectUri?: string;
  readonly skipNonceCheck: boolean;
  readonly emailOptional: boolean;
}

/**
 * Go's `appendGotrueExternalProviderEnv` presence-filtering (`start.go:1442-
 * 1462`): Go's `Auth.External` is a genuine `map[string]provider{}` containing
 * only the providers a user's `config.toml` actually mentions, but
 * `@supabase/config`'s schema always decodes a fixed set of ~19 known
 * providers, each defaulting `enabled: false` regardless of TOML presence — so
 * presence must be read from the raw document, same approach
 * {@link validateAuthExternalProviders} below uses.
 *
 * `auth.external.<name>.*` is Viper-bound like every other nested field once
 * `[auth.external.<name>]` is present in config.toml (`ExperimentalBindStruct`/
 * `AutomaticEnv`, `config.go:581-586`), so `SUPABASE_AUTH_EXTERNAL_<NAME>_*`
 * overrides apply before Go's `appendGotrueExternalProviderEnv` runs — Go has
 * no separate "raw" vs. "effective" provider value, so this must be reflected
 * in GoTrue's actual container env, not just validation.
 *
 * Hoisted (like {@link legacyResolveAuthHooks}/{@link legacyResolveAuthCaptcha})
 * so both {@link validateAuthExternalProviders} (which derives its
 * enabled/client_id/secret checks from this same unfiltered result) and
 * `start.handler.ts`'s `resolveGotrueEnvInput` (the actual GoTrue env) resolve
 * the SAME effective values.
 */
/**
 * Go decodes ANY unmodeled/raw-document boolean field — a custom `map[string]provider` entry
 * (`Enabled bool`, `pkg/config/auth.go:361-369`), `auth.passkey.enabled` (`auth.go:384-386`), etc.
 * — through its own typed struct field regardless of TOML-vs-env origin: an `env(VAR)`-substituted
 * string is weakly-coerced to `bool` by mapstructure's `WeaklyTypedInput`/`strconv.ParseBool`
 * (`config.go:749-756`) before `Config` ever sees it, so Go never has an untyped raw string for
 * these fields. `@supabase/config` has no schema at all for `auth.passkey`/`auth.webauthn`, and only
 * recognizes the ~19 known provider ids for `auth.external` (`packages/config/src/auth/
 * providers.ts`) — so for any of these unmodeled paths, the pre-decode `env(...)` walker
 * substitutes the env value but skips type coercion (no schema AST at that path —
 * `packages/config/src/lib/env.ts:308-314`), leaving e.g. `enabled = "env(CUSTOM_OAUTH_ENABLED)"`
 * as the literal string `"true"`/`"false"` instead of a real boolean. A native TOML `true`/`false`
 * literal still decodes to an actual `boolean` even for an unmodeled key (only `env(...)`
 * substitution is schema-blind), so this must accept both. Used by
 * {@link legacyResolveAuthExternalProviders} below AND by `start.handler.ts`'s
 * `resolveGotruePasskeyWebauthn`/this file's own passkey-validation read, since both are
 * unmodeled-document reads of the identical shape.
 *
 * An unparsable STRING (e.g. a typo, or a still-literal `"env(VAR)"` when the referenced var was
 * never set) is a hard `Config.Load` failure in Go, not a silent `false` — `v.UnmarshalExact`'s
 * `strconv.ParseBool` decode hook (`config.go:747-753`) errors on it, and that error propagates as
 * `"failed to parse config: %w"`, same as {@link legacyEnvOverrideBool}'s identical treatment for
 * schema-modeled bool fields. Silently defaulting to `false` here would both misreport a broken
 * config as "section disabled" AND skip the required-field validation an enabled section should
 * trigger. An absent value (`undefined` — key genuinely not present) is NOT an error: that's Go's
 * own zero-value bool default, unchanged.
 *
 * Viper's decoder sets `WeaklyTypedInput: true` (its own hardcoded default —
 * `defaultDecoderConfig`, `viper.go:976-994` — the `UnmarshalExact` call site only overrides
 * `TagName`/`Squash`/`ZeroFields`/`DecodeHook`, never touching this flag), so a raw NUMBER for a
 * `bool` field is NOT an error in Go either — mapstructure's `decodeBool` weakly coerces it via a
 * truthiness check (`mapstructure.go:915-920`: int/uint/float `!= 0`), e.g. `enabled = 123` decodes
 * as `true`, `enabled = 0` as `false`. Only a genuinely unconvertible type — an array or inline
 * table (TOML's only other value kinds) — hits mapstructure's `default:` case
 * (`mapstructure.go:933-936`), which errors unconditionally regardless of `WeaklyTypedInput`. So
 * this function must weakly-coerce a JS `number` the same way, and only throw for anything else.
 */
export function legacyRawUnmodeledBool(value: unknown, dottedFieldPath: string): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const parsed = legacyParseGoBool(value);
    if (parsed === undefined) {
      throw new LegacyInvalidBoolEnvOverrideError(dottedFieldPath, value);
    }
    return parsed;
  }
  throw new LegacyInvalidBoolEnvOverrideError(dottedFieldPath, String(value));
}

/**
 * Go's `strToArr` (`pkg/config/utils.go:86-92`): empty string → `[]`, else a plain comma-split, no
 * trimming — the same semantic `mapstructure.StringToSliceHookFunc(",")` applies unconditionally to
 * every `[]string`-typed config field during decode (`config.go:775-784`), so a raw or
 * `env(VAR)`-resolved string destined for a slice field (e.g. `auth.webauthn.rp_origins`, which
 * `@supabase/config` has no schema for at all) must be split the same way, not just accepted when
 * it's already a JS array. Hoisted here (was duplicated in `config/push/config-sync/{api,auth}.
 * sync.ts`) since it's now needed by a third, unrelated call site.
 */
export function legacyStrToArr(value: string): Array<string> {
  return value.length === 0 ? [] : value.split(",");
}

export function legacyResolveAuthExternalProviders(
  authDocument: Readonly<Record<string, unknown>> | undefined,
  external: ProjectConfig["auth"]["external"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): Record<string, LegacyResolvedAuthExternalProvider> {
  const externalDoc = asRecord(authDocument?.["external"]);
  if (externalDoc === undefined) return {};

  const result: Record<string, LegacyResolvedAuthExternalProvider> = {};
  const decodedProviders = new Map(Object.entries(external));
  // Iterate the RAW document's keys, not `Object.entries(external)` — see this
  // function's doc comment above for why (unmodeled/custom provider names).
  for (const name of Object.keys(externalDoc)) {
    if (LEGACY_DEPRECATED_EXTERNAL_PROVIDERS.has(name)) continue;
    const envPrefix = `SUPABASE_AUTH_EXTERNAL_${name.toUpperCase()}`;
    const provider = decodedProviders.get(name);
    const rawProvider = provider === undefined ? asRecord(externalDoc[name]) : undefined;
    if (provider === undefined && rawProvider === undefined) continue;
    const configuredEnabled =
      provider?.enabled ??
      legacyRawUnmodeledBool(rawProvider?.["enabled"], `auth.external.${name}.enabled`);
    const configuredClientId =
      provider?.client_id ??
      (typeof rawProvider?.["client_id"] === "string" ? rawProvider["client_id"] : undefined);
    const configuredSecret =
      provider?.secret ??
      (typeof rawProvider?.["secret"] === "string" ? rawProvider["secret"] : undefined);
    const configuredUrl =
      provider?.url ?? (typeof rawProvider?.["url"] === "string" ? rawProvider["url"] : undefined);
    const configuredRedirectUri =
      provider?.redirect_uri ??
      (typeof rawProvider?.["redirect_uri"] === "string" ? rawProvider["redirect_uri"] : undefined);
    const configuredSkipNonceCheck =
      provider?.skip_nonce_check ??
      legacyRawUnmodeledBool(
        rawProvider?.["skip_nonce_check"],
        `auth.external.${name}.skip_nonce_check`,
      );
    const configuredEmailOptional =
      provider?.email_optional ??
      legacyRawUnmodeledBool(
        rawProvider?.["email_optional"],
        `auth.external.${name}.email_optional`,
      );

    result[name] = {
      enabled: legacyEnvOverrideBool(
        `${envPrefix}_ENABLED`,
        configuredEnabled,
        `auth.external.${name}.enabled`,
        projectEnvValues,
      ),
      clientId:
        legacyEnvOverride(`${envPrefix}_CLIENT_ID`, configuredClientId, projectEnvValues) ?? "",
      secret: legacyDecryptAuthSecret(
        legacyEnvOverride(`${envPrefix}_SECRET`, configuredSecret, projectEnvValues),
        projectEnvValues,
      ),
      url: legacyEnvOverride(`${envPrefix}_URL`, configuredUrl, projectEnvValues) ?? "",
      redirectUri: legacyEnvOverride(
        `${envPrefix}_REDIRECT_URI`,
        configuredRedirectUri,
        projectEnvValues,
      ),
      skipNonceCheck: legacyEnvOverrideBool(
        `${envPrefix}_SKIP_NONCE_CHECK`,
        configuredSkipNonceCheck,
        `auth.external.${name}.skip_nonce_check`,
        projectEnvValues,
      ),
      emailOptional: legacyEnvOverrideBool(
        `${envPrefix}_EMAIL_OPTIONAL`,
        configuredEmailOptional,
        `auth.external.${name}.email_optional`,
        projectEnvValues,
      ),
    };
  }
  return result;
}

/**
 * Go's `(e external) validate()` (`pkg/config/config.go:1419-1451`) — D-only per
 * `legacy-config-validate.ts`'s module header ("`auth.external` ... stays 100% inline in D"), so
 * this ports the identical inline block D already has (`legacy-db-config.toml-read.ts`'s "B5:
 * external providers") to close the same gap for L. `auth.external` is a genuine Go
 * `map[string]provider` (`apps/cli-go/pkg/config/auth.go:190`), so an arbitrary/unmodeled
 * provider name (e.g. `[auth.external.custom]`) is a legitimate config shape — Go validates
 * every enabled entry regardless of name. `@supabase/config`'s `external` schema only models the
 * ~20 known provider ids and silently drops anything else at decode time
 * (`packages/config/src/auth/providers.ts`), so an unmodeled provider's required-field check
 * must run against the RAW `authDocument` instead of the decoded `ProjectConfig` — same
 * document-based approach as {@link readAuthEmailTemplateContent}/the passkey/smtp checks above.
 * Known providers are already covered by the schema's own `requiredWhenEnabled` check at decode
 * time, so in practice this only ever fires for a name the schema doesn't model, but it runs
 * over every raw key unconditionally, matching Go's own map iteration rather than special-casing
 * "unknown" a different way. `authDocument`'s values are already post-`env()`-interpolation (see
 * `LoadedProjectConfig.document`), so no `legacyExpandEnv`-style resolution is needed here,
 * unlike D's raw pre-interpolation document.
 *
 * `auth.external.<name>.*` is Viper-bound like every other nested field once
 * `[auth.external.<name>]` is present in config.toml (`ExperimentalBindStruct`/`AutomaticEnv`,
 * `config.go:581-586`), so `SUPABASE_AUTH_EXTERNAL_<NAME>_ENABLED`/`_CLIENT_ID`/`_SECRET`
 * overrides apply before this validation runs — same gap this schema's own `requiredWhenEnabled`
 * check has for KNOWN providers too (that check only sees the decoded, pre-override TOML value),
 * so this now covers both known and unmodeled provider names uniformly, matching Go not
 * distinguishing between them either.
 */
function validateAuthExternalProviders(
  authDocument: Record<string, unknown> | undefined,
  external: ProjectConfig["auth"]["external"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): void {
  // Derived from `legacyResolveAuthExternalProviders`'s unfiltered result so this validation
  // path and `start.handler.ts`'s GoTrue env builder can't drift — same precedent as
  // `legacyResolveAuthHooks`'s validation caller above.
  const resolved = legacyResolveAuthExternalProviders(authDocument, external, projectEnvValues);
  for (const [name, provider] of Object.entries(resolved)) {
    if (!provider.enabled) continue;
    if (provider.clientId.length === 0) {
      throw new LegacyConfigValidateError(
        `Missing required field in config: auth.external.${name}.client_id`,
      );
    }
    if (
      name !== "apple" &&
      name !== "google" &&
      (provider.secret === undefined || provider.secret.length === 0)
    ) {
      throw new LegacyConfigValidateError(
        `Missing required field in config: auth.external.${name}.secret`,
      );
    }
  }
}

/**
 * @throws when `project_id` (post-override, post-workdir-basename-fallback) is
 * an explicit empty string. Go's `Config.Validate` checks this FIRST, before
 * every other field (`pkg/config/config.go:990-991`): `mergeDefaultValues`
 * merges `sanitizeProjectId(filepath.Base(cwd))` in as a viper DEFAULT value
 * BEFORE `config.toml` is merged (`config.go:690-699`, via `Eject`,
 * `config.go:561-570`) — so `c.ProjectId` is NEVER Go's zero value by the time
 * `Validate` runs; it's always at least this sanitized basename. A workdir
 * whose basename sanitizes to the empty string (e.g. `!!!`) therefore fails
 * config loading in Go even with NO `project_id` key in the file at all. An
 * explicit `project_id = ""` IN the file overwrites that default with the
 * literal empty string the same way (rather than being treated as absent) —
 * Go fails outright rather than falling back to the basename either way.
 * `legacySanitizeProjectId` is only applied to the BASENAME fallback here,
 * matching `Eject`'s pre-sanitized default — an explicit non-empty
 * `config.project_id`/`SUPABASE_PROJECT_ID` value is intentionally NOT
 * re-sanitized at this point, matching Go's `Validate` "auto-fix" branch
 * (`config.go:992-996`) being a WARN-only rewrite with no throwing
 * equivalent, same precedent as this module's other WARN-only omissions
 * (`auth.captcha.secret`/`assertEnvLoaded`, SMS's `EnableSignup` case).
 * @throws {LegacyInvalidJwtSecretError} when `auth.jwt_secret` is set but too short.
 * @throws {LegacyInvalidPortEnvOverrideError} when a `SUPABASE_*_PORT` env/dotenv
 * override doesn't parse as a valid port.
 * @throws {LegacyInvalidBoolEnvOverrideError} when a `SUPABASE_*_ENABLED` env/dotenv
 * override doesn't parse as a valid bool.
 * @throws when a configured `api.tls` cert/key file can't be read — see
 * {@link readApiTlsFiles}. The "exactly one of cert/key set" presence check
 * runs later, as part of {@link legacyValidateResolvedConfig}.
 * @throws when `auth.signing_keys_path` is set, auth is enabled, and the file is missing,
 * malformed, or its first key uses an unsupported algorithm — see
 * {@link legacyResolveConfiguredSigningKeys} and {@link legacyGenerateAsymmetricGoJwt}.
 * @throws when an email template's `content` is present without `content_path`, or a
 * configured `content_path` file can't be read — see {@link readAuthEmailTemplateContent}.
 * @throws {LegacyInvalidAnalyticsBackendEnvOverrideError} when `SUPABASE_ANALYTICS_BACKEND`
 * doesn't parse as one of Go's `LogflareBackend` values.
 * @throws {LegacyConfigValidateError} for every other `Config.Validate` branch this module
 * and `legacy-config-validate.ts` jointly own — project_id emptiness aside (checked above,
 * inline, since the value is also needed for the throw's own message-free early-exit shape),
 * every REMAINING pure check (api.port/tls presence, db.port/major_version, storage bucket
 * names, studio, local_smtp, auth.site_url/captcha/passkey/hooks/mfa/smtp/third_party,
 * function slugs, edge_runtime.deno_version, analytics.gcp_*, experimental.*) is deferred to a
 * SINGLE call to {@link legacyValidateResolvedConfig} at the end of this function, in Go's exact
 * relative order — see that module's header for the full table and the accepted ordering
 * tradeoff this introduces against the I/O checks listed above (which keep running at their
 * original position, per-caller, rather than being folded into that single call).
 */
export function legacyResolveLocalConfigValues(
  config: ProjectConfig,
  hostname: string,
  workdir: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined = undefined,
  /**
   * `LoadedProjectConfig.document` (`packages/config/src/io.ts`) — the raw,
   * pre-schema-default TOML document `config` was decoded from. Lets checks
   * that hinge on TOML-section PRESENCE (not the decoded, always-defaulted
   * value) inspect the file directly — see `legacyValidateResolvedConfig`'s
   * `experimental.webhooks`/`auth.passkey`/`auth.email.smtp` steps.
   * `undefined` for callers that haven't threaded it through yet (e.g. most
   * existing unit tests); those checks are then simply skipped rather than
   * guessed at.
   */
  document: Readonly<Record<string, unknown>> | undefined = undefined,
): LegacyLocalConfigValues {
  // Go's `Config.Validate` checks `ProjectId` FIRST, before every other field
  // (`pkg/config/config.go:990-991`) — see this function's `@throws` doc above
  // for why a workdir basename that sanitizes to `""` fails here even when
  // `project_id` is absent from the file entirely. `config.project_id` is
  // `undefined` only when the key is genuinely absent (`optionalKey`, see
  // `packages/config/src/base.ts`) — that's the ONE case where Go's own
  // sanitized-basename viper default shows through instead of a file value,
  // so the fallback belongs here, not as a third branch after `legacyEnvOverride`.
  // `SUPABASE_PROJECT_ID` is checked via the same `legacyEnvOverride` precedence
  // every other field here uses, since Viper's `AutomaticEnv` binds it too
  // (`config.go:529-535`) and it can turn an explicit-empty file value (or an
  // unsanitizable basename fallback) back into a valid override.
  const resolvedProjectId = legacyEnvOverride(
    "SUPABASE_PROJECT_ID",
    config.project_id ?? legacySanitizeProjectId(basename(workdir)),
    projectEnvValues,
  );

  // Go's `status` reads `utils.Config.Api.Port`/`ExternalUrl`/`Tls.Enabled`
  // after Viper's AutomaticEnv has already applied any `SUPABASE_API_PORT`/
  // `SUPABASE_API_EXTERNAL_URL`/`SUPABASE_API_TLS_ENABLED` override
  // (`config.go:529-535,799-809`), so the values fed into
  // `legacyResolveApiExternalUrl`'s own `external_url`-wins-else-
  // `scheme://host:port` derivation (which picks `https` vs `http` from
  // `tls.enabled`) must be the overridden ones too.
  const apiTlsEnabled = legacyEnvOverrideBool(
    "SUPABASE_API_TLS_ENABLED",
    config.api.tls.enabled,
    "api.tls.enabled",
    projectEnvValues,
  );
  // Go's TLS cert/key validation nests entirely inside `if c.Api.Enabled`
  // (`config.go:1006,1010`) — mirroring `authEnabled` below, gate on the
  // POST-`SUPABASE_API_ENABLED`-override value, not raw `config.api.enabled`.
  const apiEnabled = legacyEnvOverrideBool(
    "SUPABASE_API_ENABLED",
    config.api.enabled,
    "api.enabled",
    projectEnvValues,
  );
  const apiTlsCertPath = legacyEnvOverride(
    "SUPABASE_API_TLS_CERT_PATH",
    config.api.tls.cert_path,
    projectEnvValues,
  );
  const apiTlsKeyPath = legacyEnvOverride(
    "SUPABASE_API_TLS_KEY_PATH",
    config.api.tls.key_path,
    projectEnvValues,
  );
  if (apiEnabled && apiTlsEnabled) {
    readApiTlsFiles(workdir, apiTlsCertPath, apiTlsKeyPath);
  }
  // Go's `Config.Validate` rejects `api.port === 0`/`SUPABASE_API_PORT=0` ONLY
  // when `api.enabled` (`pkg/config/config.go:1006-1008`) — unlike `db.port`
  // below, which has no `enabled` gate. Resolved once into a named const so the
  // check and the URL derivation below share the same overridden value instead
  // of calling `legacyEnvOverridePort` twice.
  const apiPort = legacyEnvOverridePort(
    "SUPABASE_API_PORT",
    config.api.port,
    "api.port",
    projectEnvValues,
  );
  const apiExternalUrl = legacyResolveApiExternalUrl(
    {
      external_url: legacyEnvOverride(
        "SUPABASE_API_EXTERNAL_URL",
        config.api.external_url,
        projectEnvValues,
      ),
      port: apiPort,
      tls: { enabled: apiTlsEnabled },
    },
    hostname,
  );
  // Unlike `api.port`/`studio.port`/`local_smtp.port` below, `db.port` has no
  // `enabled` gate in Go's `Config.Validate` — it's unconditionally required,
  // and a decoded `0` (e.g. `SUPABASE_DB_PORT=0`) fails validation with this
  // exact message (`pkg/config/config.go:1031-1032`) before `status`/`stop`
  // render anything, same wording already used for the `db query`/`test db`
  // path (`legacy-db-config.toml-read.ts:1380`).
  const dbPort = legacyEnvOverridePort(
    "SUPABASE_DB_PORT",
    config.db.port,
    "db.port",
    projectEnvValues,
  );
  // Go's `Config.Validate` checks `db.major_version` right after `db.port`
  // (`pkg/config/config.go:1034-1061`), unconditionally (no `enabled` gate).
  const majorVersion = legacyEnvOverrideMajorVersion(config.db.major_version, projectEnvValues);
  // Go's `flags.LoadConfig` applies every `SUPABASE_DB_SETTINGS_*` override unconditionally
  // during `Config.Load` (`config.go:576-586`), BEFORE `start`/`status`/`stop` do anything else
  // (`internal/start/start.go:51` runs before `AssertSupabaseDbIsRunning` at line 54; `status.
  // Run`/`stop.Run` load config first too) — so a malformed override must fail here, the same
  // point `majorVersion`/`denoVersion`/`orioledbVersion` are already validated, not deep inside
  // `start.handler.ts`'s `bringUp` after Postgres may already be created. Validate-only: the
  // actual resolved settings `start` needs are recomputed at their own call site (same
  // "validate early, recompute at point of use" split already used for those three fields).
  legacyResolveDbSettingsEnvOverrides(config.db.settings, projectEnvValues);
  // `db.root_key` isn't modeled in `@supabase/config`'s schema (every other
  // `db.*` field is), so it's read off the raw pre-schema document — same
  // presence-based pattern as `authDocument` below. Go writes the
  // default-or-configured, decrypted-if-`encrypted:` value verbatim into
  // `/etc/postgresql-custom/pgsodium_root.key` on every start
  // (`apps/cli-go/internal/db/start/start.go:100`), going through the same
  // `Secret`/`DecryptSecretHookFunc` decode every other secret field gets
  // (`pkg/config/secret.go:30-109`, wired at `pkg/config/config.go:781`).
  const rawRootKeyValue = asRecord(document?.["db"])?.["root_key"];
  // Go's `DecryptSecretHookFunc` only intercepts a STRING source value
  // (`secret.go:86-89`); any other raw TOML kind (integer, bool, array, ...)
  // falls through untouched and mapstructure then rejects decoding a scalar
  // into the `Secret{Value, SHA256}` struct with exactly this message
  // (`config.go:748-751` wraps it as `failed to parse config: %w`) — same
  // "decoding failed due to the following error(s):" wrapper already used for
  // `auth.captcha.provider`/`analytics.backend` above.
  if (rawRootKeyValue !== undefined && typeof rawRootKeyValue !== "string") {
    throw new LegacyConfigValidateError(
      "failed to parse config: decoding failed due to the following error(s):\n\n'db.root_key' expected a map or struct",
    );
  }
  const rawRootKey = legacyEnvOverride("SUPABASE_DB_ROOT_KEY", rawRootKeyValue, projectEnvValues);
  const rootKey =
    rawRootKey === undefined || rawRootKey.length === 0
      ? LEGACY_POSTGRES_DEFAULT_ROOT_KEY
      : (legacyDecryptAuthSecret(rawRootKey, projectEnvValues) ?? LEGACY_POSTGRES_DEFAULT_ROOT_KEY);
  // Go's `Config.Validate` runs `ValidateBucketName` over every `[storage.buckets.*]`
  // key right after `db.major_version`, unconditionally.
  const storageBucketNames =
    config.storage.buckets !== undefined ? Object.keys(config.storage.buckets) : [];
  // Go's `Config.Validate` rejects `studio.port === 0`/`SUPABASE_STUDIO_PORT=0`
  // ONLY when `studio.enabled` (`pkg/config/config.go:1070-1073`) — same
  // enabled-gated pattern as `api.port` above.
  const studioEnabled = legacyEnvOverrideBool(
    "SUPABASE_STUDIO_ENABLED",
    config.studio.enabled,
    "studio.enabled",
    projectEnvValues,
  );
  const studioPort = legacyEnvOverridePort(
    "SUPABASE_STUDIO_PORT",
    config.studio.port,
    "studio.port",
    projectEnvValues,
  );
  // Go's `Config.Validate` parses `studio.api_url` with `net/url.Parse` right
  // after the port check, still inside `if c.Studio.Enabled`
  // (`pkg/config/config.go:1074-1078`). `config.studio.api_url` is a required
  // (defaulted) field, so `legacyEnvOverride` can only return `undefined` here if
  // that default itself were somehow undefined — the `??` fallback just
  // satisfies that generic signature.
  const studioApiUrl =
    legacyEnvOverride("SUPABASE_STUDIO_API_URL", config.studio.api_url, projectEnvValues) ??
    config.studio.api_url;
  // Go's `Config.Validate` rejects `local_smtp.port === 0`/
  // `SUPABASE_LOCAL_SMTP_PORT=0` ONLY when `local_smtp.enabled` — Go's struct
  // field is still named `Inbucket` for the `[local_smtp]` TOML section
  // (`pkg/config/config.go:235,1081-1083`), so `local_smtp.enabled` and the
  // deprecated `inbucket.enabled` alias are the same underlying flag, not two
  // independent ones.
  const mailpitEnabled = legacyEnvOverrideBool(
    "SUPABASE_LOCAL_SMTP_ENABLED",
    config.local_smtp.enabled,
    "local_smtp.enabled",
    projectEnvValues,
  );
  const mailpitPort = legacyEnvOverridePort(
    "SUPABASE_LOCAL_SMTP_PORT",
    config.local_smtp.port,
    "local_smtp.port",
    projectEnvValues,
  );
  const jwtSecret = resolveJwtSecret(
    legacyDecryptAuthSecret(
      legacyEnvOverride("SUPABASE_AUTH_JWT_SECRET", config.auth.jwt_secret, projectEnvValues),
      projectEnvValues,
    ),
  );
  const signingKeysPath = legacyEnvOverride(
    "SUPABASE_AUTH_SIGNING_KEYS_PATH",
    config.auth.signing_keys_path,
    projectEnvValues,
  );
  // Gated on `auth.enabled` to match Go's `Validate` (`pkg/config/config.go:1036,1059-1065`):
  // the signing-keys file read lives entirely inside `if c.Auth.Enabled`, so a
  // disabled auth section never opens/parses `signing_keys_path`, even a stale
  // or missing one. JWT-secret validation and anon/service_role key generation
  // (`generateAPIKeys`, `apikeys.go:43-73`) run unconditionally either way, so
  // only this file read is gated. `c.Auth.Enabled` is itself Viper-bound like
  // any other field (`config.go:582-586`), so `Validate`'s gate reads the
  // POST-`SUPABASE_AUTH_ENABLED`-override value, not the raw TOML one — hence
  // `legacyEnvOverrideBool` here instead of `config.auth.enabled` directly.
  const authEnabled = legacyEnvOverrideBool(
    "SUPABASE_AUTH_ENABLED",
    config.auth.enabled,
    "auth.enabled",
    projectEnvValues,
  );
  // Go's `Config.Validate` checks `auth.site_url` first inside `if c.Auth.Enabled`
  // (`pkg/config/config.go:1086-1090`), before the signing-keys read below —
  // `@supabase/config`'s schema only defaults `site_url` when the key is ABSENT
  // (`Schema.withDecodingDefaultKey`), so an explicit `site_url = ""` decodes as
  // `""` with no schema-level error, same gap as `db.port === 0` above.
  const siteUrl =
    legacyEnvOverride("SUPABASE_AUTH_SITE_URL", config.auth.site_url, projectEnvValues) ??
    config.auth.site_url;
  // Go's `start.go` builds GoTrue's env straight off `utils.Config.Auth.*`
  // with no local override logic of its own (`start.go:1365-1405`) — the
  // override happens earlier, generically, via Viper's `AutomaticEnv`
  // (`config.go:585-586`), so every flat `auth.*` scalar Go feeds into
  // GoTrue's env must go through the same override resolution `siteUrl`
  // above already gets, not just the fields `Validate` happens to check.
  const jwtIssuer = legacyEnvOverride(
    "SUPABASE_AUTH_JWT_ISSUER",
    config.auth.jwt_issuer,
    projectEnvValues,
  );
  const jwtExpiry = legacyEnvOverrideUint(
    "SUPABASE_AUTH_JWT_EXPIRY",
    "auth.jwt_expiry",
    config.auth.jwt_expiry,
    projectEnvValues,
  );
  // Go decodes `additional_redirect_urls` (a `[]string`) through the same
  // `StringToSliceHookFunc(",")` mapstructure hook as every other Go
  // string-slice field (`config.go:775-784`) — same comma-split-override
  // pattern as `auth.webauthn.rp_origins` below.
  const additionalRedirectUrlsOverride = legacyEnvOverride(
    "SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS",
    undefined,
    projectEnvValues,
  );
  const additionalRedirectUrls =
    additionalRedirectUrlsOverride !== undefined
      ? additionalRedirectUrlsOverride.split(",")
      : config.auth.additional_redirect_urls;
  const enableSignup = legacyEnvOverrideBool(
    "SUPABASE_AUTH_ENABLE_SIGNUP",
    config.auth.enable_signup,
    "auth.enable_signup",
    projectEnvValues,
  );
  const enableAnonymousSignIns = legacyEnvOverrideBool(
    "SUPABASE_AUTH_ENABLE_ANONYMOUS_SIGN_INS",
    config.auth.enable_anonymous_sign_ins,
    "auth.enable_anonymous_sign_ins",
    projectEnvValues,
  );
  const enableRefreshTokenRotation = legacyEnvOverrideBool(
    "SUPABASE_AUTH_ENABLE_REFRESH_TOKEN_ROTATION",
    config.auth.enable_refresh_token_rotation,
    "auth.enable_refresh_token_rotation",
    projectEnvValues,
  );
  const refreshTokenReuseInterval = legacyEnvOverrideUint(
    "SUPABASE_AUTH_REFRESH_TOKEN_REUSE_INTERVAL",
    "auth.refresh_token_reuse_interval",
    config.auth.refresh_token_reuse_interval,
    projectEnvValues,
  );
  const enableManualLinking = legacyEnvOverrideBool(
    "SUPABASE_AUTH_ENABLE_MANUAL_LINKING",
    config.auth.enable_manual_linking,
    "auth.enable_manual_linking",
    projectEnvValues,
  );
  const minimumPasswordLength = legacyEnvOverrideUint(
    "SUPABASE_AUTH_MINIMUM_PASSWORD_LENGTH",
    "auth.minimum_password_length",
    config.auth.minimum_password_length,
    projectEnvValues,
  );
  // Go's `PasswordRequirements.UnmarshalText` (`pkg/config/auth.go:26-31`)
  // hard-fails config loading on a value outside this fixed set — same
  // decode-time-failure semantics as the numeric overrides above, just
  // string-typed.
  const passwordRequirementsOverride = legacyEnvOverride(
    "SUPABASE_AUTH_PASSWORD_REQUIREMENTS",
    undefined,
    projectEnvValues,
  );
  if (
    passwordRequirementsOverride !== undefined &&
    !LEGACY_PASSWORD_REQUIREMENTS_VALUES.has(passwordRequirementsOverride)
  ) {
    throw new Error(
      `Failed reading config: Invalid auth.password_requirements: ${passwordRequirementsOverride}.`,
    );
  }
  const passwordRequirements = passwordRequirementsOverride ?? config.auth.password_requirements;
  // `LoadedProjectConfig.document` (the raw, pre-schema-default TOML `config` was decoded from) —
  // hoisted here (rather than inside the `authEnabled` block below, where it used to live) because
  // the captcha presence check right below needs it too. `undefined` for callers that haven't
  // threaded `document` through yet, in which case presence-based checks are simply skipped.
  const authDocument = asRecord(document?.["auth"]);
  const captchaInput = legacyResolveAuthCaptcha(
    authDocument,
    config.auth.captcha,
    projectEnvValues,
  );
  // Go's `generateJWT` (`apikeys.go:77`) signs asymmetrically whenever
  // `len(a.SigningKeysPath) > 0 && len(a.SigningKeys) > 0` — NOT gated on `auth.enabled`. Since
  // `a.SigningKeys` is unconditionally seeded with the default ES256 key at `NewConfig()` time
  // and only ever replaced by the file's keys (when the read above actually runs), it's never
  // empty either way — so this reduces to "does `signing_keys_path` resolve to a key at all,"
  // matching {@link legacyResolveLocalJwks}'s identical `signingKeysPath`-only condition. Reuses
  // {@link legacyResolveConfiguredSigningKeys} (which already gates the actual file read on
  // `authEnabled` internally, matching the file-read gating above) rather than duplicating that
  // gate here — a disabled-auth config with a configured path must still sign asymmetrically
  // with the default key, not silently fall back to symmetric HS256.
  const signingKey =
    signingKeysPath !== undefined && signingKeysPath.length > 0
      ? (legacyResolveConfiguredSigningKeys(config, workdir, projectEnvValues) ?? [
          LEGACY_DEFAULT_SIGNING_KEY,
        ])[0]
      : undefined;
  // Go's `Config.Validate` runs passkey/webauthn validation, then
  // `Auth.Hook.validate()`, then `Auth.MFA.validate()`, then
  // `Auth.Email.validate()`, then `Auth.Sms.validate()`/`Auth.ThirdParty.validate()` (skipping
  // the D-only `external` step, ported separately below), all right after the signing-keys read
  // and still inside `if c.Auth.Enabled` (`pkg/config/config.go:1117-1153`). Sms
  // (`config.go:1145-1147`/`1348-1417`) is enforced at decode time by `@supabase/config`'s `sms`
  // schema (`packages/config/src/auth/sms.ts`'s provider-switch check) for the TOML-only case,
  // AND re-checked here post-env-override by {@link validateAuthSmsProviders} (called alongside
  // {@link validateAuthExternalProviders}, after the single `legacyValidateResolvedConfig` call
  // below) — see that function's doc comment for why both are needed. External
  // (`config.go:1148-1150`/`1419-1451`) is D-only per `legacy-config-validate.ts`'s module
  // header; {@link validateAuthExternalProviders} ports D's identical inline check. This block
  // only ACCUMULATES the inputs those checks need — the checks themselves run once, later, as
  // part of the single `legacyValidateResolvedConfig` call below.
  let authInput: LegacyAuthInput | undefined;
  if (authEnabled) {
    // `@supabase/config`'s auth schema has no `passkey`/`webauthn` fields at all (see
    // `config-sync/auth.sync.ts`'s "not in `@supabase/config` schema" note), so passkey/webauthn
    // are read from the RAW, post-`env()`-interpolation TOML document (`authDocument`, hoisted
    // above) instead of the decoded `ProjectConfig` — same document-based approach already used
    // on the `db`/migration config-load path (`legacy-db-config.toml-read.ts`'s
    // `legacyValidateAuthConfig`, section A6). `authDocument` is `undefined` when a caller hasn't
    // threaded `document` through yet, in which case passkey/smtp presence-based checks are
    // simply skipped rather than guessed at.
    const passkeyDoc = asRecord(authDocument?.["passkey"]);
    const webauthnDoc = asRecord(authDocument?.["webauthn"]);
    // `auth.passkey.enabled`/`auth.webauthn.*` are Viper-bound like every other nested field once
    // `[auth.passkey]`/`[auth.webauthn]` are present in config.toml (`ExperimentalBindStruct`/
    // `AutomaticEnv`, `config.go:581-586`), so `SUPABASE_AUTH_PASSKEY_ENABLED` and
    // `SUPABASE_AUTH_WEBAUTHN_RP_ID`/`_RP_ORIGINS` overrides apply before `Auth.Passkey`/
    // `Auth.Webauthn` validation runs (`config.go:1117-1134`). Gated on the raw section already
    // being present (`passkeyDoc`/`webauthnDoc !== undefined`), matching Go's `AutomaticEnv`
    // (which only intercepts keys already present in the merged config) — an absent
    // `[auth.passkey]`/`[auth.webauthn]` section is never synthesized from an env override alone.
    const passkeyEnabled =
      passkeyDoc !== undefined
        ? legacyEnvOverrideBool(
            "SUPABASE_AUTH_PASSKEY_ENABLED",
            legacyRawUnmodeledBool(passkeyDoc["enabled"], "auth.passkey.enabled"),
            "auth.passkey.enabled",
            projectEnvValues,
          )
        : false;
    const rpId =
      webauthnDoc !== undefined
        ? legacyEnvOverride(
            "SUPABASE_AUTH_WEBAUTHN_RP_ID",
            typeof webauthnDoc["rp_id"] === "string" ? webauthnDoc["rp_id"] : undefined,
            projectEnvValues,
          )
        : undefined;
    // Go decodes `rp_origins` (a `[]string`) through the same `StringToSliceHookFunc(",")`
    // mapstructure hook as every other Go string-slice field (`config.go:775-784`), so a
    // `SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS` override is comma-split the same way.
    const rpOriginsOverride =
      webauthnDoc !== undefined
        ? legacyEnvOverride("SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS", undefined, projectEnvValues)
        : undefined;
    // Go's mapstructure decode chain applies `StringToSliceHookFunc(",")` unconditionally to
    // every `[]string`-typed field (`config.go:775-784`) — a raw or `env(...)`-resolved
    // `rp_origins` string (this section has no `@supabase/config` schema at all) must be
    // comma-split, not silently dropped when it isn't already a JS array.
    const rawRpOrigins = webauthnDoc?.["rp_origins"];
    const rpOrigins =
      rpOriginsOverride !== undefined
        ? legacyStrToArr(rpOriginsOverride)
        : Array.isArray(rawRpOrigins)
          ? rawRpOrigins
          : typeof rawRpOrigins === "string"
            ? legacyStrToArr(rawRpOrigins)
            : undefined;
    const passkey: LegacyPasskeyInput | undefined = passkeyEnabled
      ? { webauthnPresent: webauthnDoc !== undefined, rpId, rpOrigins }
      : undefined;

    // Only enabled hooks are forwarded to `Config.Validate` parity, in Go's
    // fixed iteration order (`pkg/config/config.go:1453-1485`) — derived from
    // `legacyResolveAuthHooks`'s unfiltered result so this validation path and
    // `resolveGotrueEnvInput`'s actual GoTrue env resolve the exact same
    // per-hook override values (see that function's doc comment).
    const resolvedHooks = legacyResolveAuthHooks(authDocument, config.auth.hook, projectEnvValues);
    const hooks: Array<LegacyHookInput> = LEGACY_HOOK_TYPE_ORDER.filter(
      (hookType) => resolvedHooks[LEGACY_HOOK_TYPE_TO_CAMEL[hookType]].enabled,
    ).map((hookType) => {
      const resolved = resolvedHooks[LEGACY_HOOK_TYPE_TO_CAMEL[hookType]];
      return { type: hookType, uri: resolved.uri, secrets: resolved.secrets };
    });

    // Derived from `legacyResolveAuthMfa`'s unfiltered result so this validation path and
    // `resolveGotrueEnvInput`'s actual GoTrue env resolve the exact same per-factor override
    // values (see that function's doc comment) — same precedent as `hooks` above.
    const resolvedMfa = legacyResolveAuthMfa(config.auth.mfa, projectEnvValues);
    const mfa: ReadonlyArray<LegacyMfaFactorInput> = [
      {
        label: "totp",
        enrollEnabled: resolvedMfa.totp.enroll_enabled,
        verifyEnabled: resolvedMfa.totp.verify_enabled,
      },
      {
        label: "phone",
        enrollEnabled: resolvedMfa.phone.enroll_enabled,
        verifyEnabled: resolvedMfa.phone.verify_enabled,
      },
      {
        label: "web_authn",
        enrollEnabled: resolvedMfa.web_authn.enroll_enabled,
        verifyEnabled: resolvedMfa.web_authn.verify_enabled,
      },
    ];

    // Go's `Config.Validate` runs the email template/notification content read right after
    // `Auth.MFA.validate()`, still inside `if c.Auth.Enabled` (`config.go:1142`) — this I/O read
    // stays at this exact textual position (see this function's `@throws` doc for why).
    readAuthEmailTemplateContent(
      legacyResolveAuthEmail(config.auth.email, authDocument, projectEnvValues),
      workdir,
      authDocument,
    );

    // Go's `[auth.email.smtp]` presence-based `enabled` default — see
    // {@link legacyResolveAuthEmailSmtp}'s doc comment.
    const resolvedSmtp = legacyResolveAuthEmailSmtp(authDocument, projectEnvValues);
    const smtp: LegacySmtpInput | undefined =
      resolvedSmtp === undefined
        ? undefined
        : {
            enabled: resolvedSmtp.enabled,
            host: resolvedSmtp.host,
            port: resolvedSmtp.port,
            user: resolvedSmtp.user,
            pass: resolvedSmtp.pass,
            adminEmail: resolvedSmtp.adminEmail,
          };

    // Go's `(tpa *thirdParty) validate()` fixed provider order (`pkg/config/config.go:1635-1683`)
    // — only enabled providers are forwarded, in that order. Like `Auth.MFA` above, each provider
    // struct (`tpaFirebase`/`tpaAuth0`/`tpaCognito`/`tpaClerk`/`tpaWorkOs`, `auth.go:191-198`) is
    // value-typed, so `SUPABASE_AUTH_THIRD_PARTY_<PROVIDER>_*` overrides always apply — including
    // `workos`, whose default template omits `[auth.third_party.workos]` entirely — before
    // `Auth.ThirdParty.validate()` runs; no raw-document presence gate needed.
    const thirdParty: Array<LegacyThirdPartyInput> = [];
    if (
      legacyEnvOverrideBool(
        "SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED",
        config.auth.third_party.firebase.enabled,
        "auth.third_party.firebase.enabled",
        projectEnvValues,
      )
    ) {
      thirdParty.push({
        provider: "firebase",
        requiredField:
          legacyEnvOverride(
            "SUPABASE_AUTH_THIRD_PARTY_FIREBASE_PROJECT_ID",
            config.auth.third_party.firebase.project_id,
            projectEnvValues,
          ) ?? "",
      });
    }
    if (
      legacyEnvOverrideBool(
        "SUPABASE_AUTH_THIRD_PARTY_AUTH0_ENABLED",
        config.auth.third_party.auth0.enabled,
        "auth.third_party.auth0.enabled",
        projectEnvValues,
      )
    ) {
      thirdParty.push({
        provider: "auth0",
        requiredField:
          legacyEnvOverride(
            "SUPABASE_AUTH_THIRD_PARTY_AUTH0_TENANT",
            config.auth.third_party.auth0.tenant,
            projectEnvValues,
          ) ?? "",
      });
    }
    if (
      legacyEnvOverrideBool(
        "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_ENABLED",
        config.auth.third_party.aws_cognito.enabled,
        "auth.third_party.aws_cognito.enabled",
        projectEnvValues,
      )
    ) {
      thirdParty.push({
        provider: "cognito",
        requiredField:
          legacyEnvOverride(
            "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_USER_POOL_ID",
            config.auth.third_party.aws_cognito.user_pool_id,
            projectEnvValues,
          ) ?? "",
        cognitoUserPoolRegion: legacyEnvOverride(
          "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_USER_POOL_REGION",
          config.auth.third_party.aws_cognito.user_pool_region,
          projectEnvValues,
        ),
      });
    }
    if (
      legacyEnvOverrideBool(
        "SUPABASE_AUTH_THIRD_PARTY_CLERK_ENABLED",
        config.auth.third_party.clerk.enabled,
        "auth.third_party.clerk.enabled",
        projectEnvValues,
      )
    ) {
      thirdParty.push({
        provider: "clerk",
        requiredField:
          legacyEnvOverride(
            "SUPABASE_AUTH_THIRD_PARTY_CLERK_DOMAIN",
            config.auth.third_party.clerk.domain,
            projectEnvValues,
          ) ?? "",
      });
    }
    if (
      legacyEnvOverrideBool(
        "SUPABASE_AUTH_THIRD_PARTY_WORKOS_ENABLED",
        config.auth.third_party.workos.enabled,
        "auth.third_party.workos.enabled",
        projectEnvValues,
      )
    ) {
      thirdParty.push({
        provider: "workos",
        requiredField:
          legacyEnvOverride(
            "SUPABASE_AUTH_THIRD_PARTY_WORKOS_ISSUER_URL",
            config.auth.third_party.workos.issuer_url,
            projectEnvValues,
          ) ?? "",
      });
    }

    authInput = {
      siteUrl: siteUrl ?? "",
      captcha: captchaInput,
      passkey,
      hooks,
      mfa,
      smtp,
      thirdParty,
    };
  }
  // Go's `Config.Validate` runs `ValidateFunctionSlug` over every `[functions.*]`
  // key right after the auth block/`generateAPIKeys`, unconditionally.
  const functionSlugs = Object.keys(config.functions);
  // Go's `Config.Validate` checks `edge_runtime.deno_version` after the auth
  // block and the functions loop (`pkg/config/config.go:1158-1173`), and —
  // unlike `studio.port`/`local_smtp.port` above — unconditionally, with no
  // `edge_runtime.enabled` gate.
  const denoVersion = legacyEnvOverrideDenoVersion(
    config.edge_runtime.deno_version,
    projectEnvValues,
  );

  // Go's `Config.Validate` validates `[analytics]` right after
  // `edge_runtime.deno_version` (`pkg/config/config.go:1174-1187`): when
  // `analytics.enabled` and `analytics.backend == "bigquery"`, all three GCP
  // fields are required, checked in that order, each with its own message.
  // Backend-enum validation (rejecting a non-postgres/bigquery value) is
  // covered at decode time for the `config.toml`-sourced value by
  // `@supabase/config`'s `stringEnum` (`packages/config/src/analytics.ts:17-41`),
  // but that schema doesn't see the `SUPABASE_ANALYTICS_BACKEND` env-override
  // path — see {@link envOverrideAnalyticsBackend} for that case.
  const analyticsEnabled = legacyEnvOverrideBool(
    "SUPABASE_ANALYTICS_ENABLED",
    config.analytics.enabled,
    "analytics.enabled",
    projectEnvValues,
  );
  const analyticsBackend = envOverrideAnalyticsBackend(config.analytics.backend, projectEnvValues);
  const gcpProjectId = legacyEnvOverride(
    "SUPABASE_ANALYTICS_GCP_PROJECT_ID",
    config.analytics.gcp_project_id,
    projectEnvValues,
  );
  const gcpProjectNumber = legacyEnvOverride(
    "SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER",
    config.analytics.gcp_project_number,
    projectEnvValues,
  );
  const gcpJwtPath = legacyEnvOverride(
    "SUPABASE_ANALYTICS_GCP_JWT_PATH",
    config.analytics.gcp_jwt_path,
    projectEnvValues,
  );

  // Go's `Config.Validate` calls `c.Experimental.validate()` right after the
  // analytics/bigquery block and right before returning. The webhooks check is NOT "the user
  // disabled a feature" — Go's bool zero-value is `false`, so `e.Webhooks != nil &&
  // !e.Webhooks.Enabled` rejects ANY present `[experimental.webhooks]` section whose `enabled`
  // isn't explicitly `true`, including one where the key is simply omitted; the section exists
  // only so it can be turned on, never explicitly off. This hinges on PRESENCE of the TOML
  // section, not the decoded `enabled` value — `@supabase/config`'s decode-time default
  // (`packages/config/src/experimental.ts`'s `withDecodingDefaultKey(Effect.succeed({}))`) fills
  // in `experimental.webhooks = { enabled: false }` on the DECODED `ProjectConfig` even when the
  // TOML section is entirely absent — verified empirically, this default-fill erases exactly the
  // presence signal this check needs. So this reads `LoadedProjectConfig.document` (the raw,
  // pre-default TOML) instead, same as the passkey/smtp checks above.
  const experimentalDocument = asRecord(document?.["experimental"]);
  const webhooksPresent = asRecord(experimentalDocument?.["webhooks"]) !== undefined;
  const webhooksEnabled = config.experimental.webhooks?.enabled === true;
  const pgdeltaFormatOptions = config.experimental.pgdelta?.format_options ?? "";

  // Every PURE Config.Validate check this module/legacy-config-validate.ts jointly own is
  // deferred to this single call, positioned here (where the last of those checks ran until
  // this commit), in Go's exact relative order against every OTHER pure check. This means a
  // config broken in TWO OR MORE independent pure-section ways reports whichever Go considers
  // first among the ones broken — unchanged from before. The only real reordering risk is
  // between a pure check and one of this function's 3 I/O reads (signing keys, api.tls
  // cert/key, email template/notification content) that in THIS function's source sits between
  // two pure sections (e.g. the signing-keys read sits between the captcha check above and the
  // passkey/hooks/mfa/email/smtp/third_party checks folded into `authInput` above) — that I/O
  // read now effectively runs BEFORE those later pure checks rather than interleaved at its
  // original relative position. This is the same narrow, accepted, documented tradeoff recorded
  // in `legacy-config-validate.ts`'s module header; every existing test constructs exactly one
  // validation failure at a time, so it has zero effect on any real test.
  const apiInput: LegacyApiInput = {
    enabled: apiEnabled,
    port: apiPort,
    tls: { enabled: apiTlsEnabled, certPath: apiTlsCertPath, keyPath: apiTlsKeyPath },
  };
  const dbInput: LegacyDbInput = { port: dbPort, majorVersion };
  const studioInput: LegacyStudioInput = {
    enabled: studioEnabled,
    port: studioPort,
    apiUrl: studioApiUrl,
  };
  const localSmtpInput: LegacyLocalSmtpInput = { enabled: mailpitEnabled, port: mailpitPort };
  const analyticsInput: LegacyAnalyticsInput = {
    enabled: analyticsEnabled,
    backend: analyticsBackend,
    gcpProjectId: gcpProjectId ?? "",
    gcpProjectNumber: gcpProjectNumber ?? "",
    gcpJwtPath: gcpJwtPath ?? "",
  };
  const experimentalInput: LegacyExperimentalInput = {
    webhooksPresent,
    webhooksEnabled,
    pgdeltaFormatOptions,
  };

  const input: LegacyConfigValidationInput = {
    projectId: resolvedProjectId,
    api: apiInput,
    db: dbInput,
    storageBucketNames,
    studio: studioInput,
    localSmtp: localSmtpInput,
    auth: authInput,
    functionSlugs,
    edgeRuntimeDenoVersion: denoVersion,
    analytics: analyticsInput,
    experimental: experimentalInput,
  };
  legacyValidateResolvedConfig(input);
  // Both run after the single shared `legacyValidateResolvedConfig` call per the module's
  // documented sms/external-vs-third_party ordering tradeoff (third_party is checked inside that
  // call; sms/external run after it here) — in Go's own relative sms-then-external order
  // (`config.go:1145-1150`). `validateAuthSmsProviders` re-runs `@supabase/config`'s schema-level
  // switch with env overrides applied (see its doc comment); `validateAuthExternalProviders` is
  // D-only per `legacy-config-validate.ts`'s module header ("auth.external ... stays 100% inline
  // in D") — this is L's port of D's identical inline block.
  if (authEnabled) {
    validateAuthSmsProviders(authDocument, config.auth.sms, projectEnvValues);
    validateAuthExternalProviders(authDocument, config.auth.external, projectEnvValues);
  }

  const openaiApiKey = legacyDecryptAuthSecret(
    legacyEnvOverride(
      "SUPABASE_STUDIO_OPENAI_API_KEY",
      config.studio.openai_api_key,
      projectEnvValues,
    ),
    projectEnvValues,
  );

  return {
    apiUrl: apiExternalUrl,
    apiPort,
    dbPort,
    studioPort,
    rootKey,
    openaiApiKey,
    authSiteUrl: siteUrl,
    authJwtIssuer: jwtIssuer,
    authJwtExpiry: jwtExpiry,
    authAdditionalRedirectUrls: additionalRedirectUrls,
    authEnableSignup: enableSignup,
    authEnableAnonymousSignIns: enableAnonymousSignIns,
    authEnableRefreshTokenRotation: enableRefreshTokenRotation,
    authRefreshTokenReuseInterval: refreshTokenReuseInterval,
    authEnableManualLinking: enableManualLinking,
    authMinimumPasswordLength: minimumPasswordLength,
    authPasswordRequirements: passwordRequirements,
    restUrl: apiUrlWithPath(apiExternalUrl, "/rest/v1"),
    graphqlUrl: apiUrlWithPath(apiExternalUrl, "/graphql/v1"),
    functionsUrl: apiUrlWithPath(apiExternalUrl, "/functions/v1"),
    mcpUrl: apiUrlWithPath(apiExternalUrl, "/mcp"),
    studioUrl: `http://${hostname}:${studioPort}`,
    mailpitUrl: `http://${hostname}:${mailpitPort}`,
    dbUrl: `postgresql://postgres:${DEFAULT_DB_PASSWORD}@${hostname}:${dbPort}/postgres`,
    publishableKey: resolveOpaqueKey(
      legacyDecryptAuthSecret(
        legacyEnvOverride(
          "SUPABASE_AUTH_PUBLISHABLE_KEY",
          config.auth.publishable_key,
          projectEnvValues,
        ),
        projectEnvValues,
      ),
      defaultPublishableKey,
    ),
    secretKey: resolveOpaqueKey(
      legacyDecryptAuthSecret(
        legacyEnvOverride("SUPABASE_AUTH_SECRET_KEY", config.auth.secret_key, projectEnvValues),
        projectEnvValues,
      ),
      defaultSecretKey,
    ),
    jwtSecret,
    anonKey: resolveSignedKey(
      legacyDecryptAuthSecret(
        legacyEnvOverride("SUPABASE_AUTH_ANON_KEY", config.auth.anon_key, projectEnvValues),
        projectEnvValues,
      ),
      jwtSecret,
      signingKey,
      "anon",
    ),
    serviceRoleKey: resolveSignedKey(
      legacyDecryptAuthSecret(
        legacyEnvOverride(
          "SUPABASE_AUTH_SERVICE_ROLE_KEY",
          config.auth.service_role_key,
          projectEnvValues,
        ),
        projectEnvValues,
      ),
      jwtSecret,
      signingKey,
      "service_role",
    ),
    storageS3Url: apiUrlWithPath(apiExternalUrl, "/storage/v1/s3"),
    storageS3AccessKeyId: DEFAULT_S3_ACCESS_KEY_ID,
    storageS3SecretAccessKey: DEFAULT_S3_SECRET_ACCESS_KEY,
    storageS3Region: DEFAULT_S3_REGION,
    analyticsEnabled,
    analyticsBackend,
    gcpProjectId: gcpProjectId ?? "",
    gcpProjectNumber: gcpProjectNumber ?? "",
    gcpJwtPath: gcpJwtPath ?? "",
  };
}

/**
 * Go's `(a *auth) ResolveJWKS(ctx)` (`apps/cli-go/pkg/config/config.go:1727-1806`) — reached only
 * from the future native `start` port (`internal/start/start.go:274-277`: a fetch failure there
 * fails the whole `start` command outright). Deliberately NOT folded into
 * {@link LegacyLocalConfigValues}/{@link legacyResolveLocalConfigValues}: that resolver is
 * synchronous and runs on every `stop`/`status` invocation (see `legacy-status-values.ts`/
 * `stop.handler.ts`), so adding this function's network round-trip (the OIDC discovery + remote
 * JWKS fetch) there would tax two commands that never render a JWKS. This is a standalone sibling
 * `start`-only callers invoke separately, alongside (not instead of) `legacyResolveLocalConfigValues`.
 *
 * Divergences from the structurally similar (but functionally unrelated) `resolveAuthArtifacts` in
 * `shared/functions/serve.ts` (Go's equivalent call site for THAT function is
 * `internal/functions/serve/`, out of scope for this port) — deliberately NOT copied here:
 *  - a remote-JWKS fetch failure is a hard, propagating error here (matching `start.go:274-277`
 *    returning the error outright); `serve.ts` instead swallows the failure and continues with
 *    zero remote keys, a `functions serve`-only leniency with no equivalent in `ResolveJWKS`.
 *  - this never injects `serve.ts`'s `defaultSigningKey` EC key — that key exists only for
 *    `functions serve`'s own local-dev defaults and has no equivalent in `ResolveJWKS`.
 *
 * Reuses {@link toPublicJwk}/{@link resolveThirdPartyIssuerUrl}/{@link resolveRemoteJwks}
 * (`shared/auth/jwks.ts`) rather than re-implementing them a second time — see that module's
 * header. `jwtSecret` is accepted as a parameter (the same value already resolved onto
 * {@link LegacyLocalConfigValues.jwtSecret} by {@link legacyResolveLocalConfigValues}/
 * {@link resolveJwtSecret}) rather than recomputed, so the two functions never disagree on it.
 *
 * `authEnabled`/`signingKeysPath` ARE recomputed here (cheap, pure `legacyEnvOverride`/
 * `legacyEnvOverrideBool` calls, no I/O) rather than threaded through from the caller's own
 * computation of the same values, keeping this function self-contained. Both this function and
 * `legacyResolveLocalConfigValues`'s own `signingKey` now share
 * {@link legacyResolveConfiguredSigningKeys} — this function needs the FULL key array (see
 * {@link loadSigningKeys}), the other only the first key to sign anon/service_role.
 *
 * `signingKeysPath`'s effect on the oct-JWT-secret fallback below matches Go's literal field
 * checks exactly, NOT "is auth enabled": Go's `a.SigningKeysPath` (`pkg/config/config.go:928-929`)
 * is resolved to an absolute path unconditionally, regardless of `auth.enabled` — only the file
 * read INTO `a.SigningKeys` is gated on `c.Auth.Enabled` (`config.go:1087,1110-1116`). So a config
 * with `auth.enabled = false` and a configured `signing_keys_path` resolves `signingKeys: []`
 * (never read) with `signingKeysPath` still non-empty — Go's fallback check
 * (`len(a.SigningKeysPath) == 0`) is then FALSE, so the oct fallback is skipped too, matching this
 * function's `signingKeysPath` emptiness check below rather than `!authEnabled`.
 *
 * @throws {LegacyConfigValidateError} when more than one `auth.third_party.*` provider is
 * enabled, an enabled provider is missing a required field, or the remote JWKS fetch (OIDC
 * discovery or the JWKS document itself) fails — matching Go's `ResolveJWKS` returning that error
 * outright, propagated here as this file's own error type rather than a bare `Error`.
 */
export async function legacyResolveLocalJwks(
  config: ProjectConfig,
  workdir: string,
  jwtSecret: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined = undefined,
): Promise<string> {
  const signingKeysPath = legacyEnvOverride(
    "SUPABASE_AUTH_SIGNING_KEYS_PATH",
    config.auth.signing_keys_path,
    projectEnvValues,
  );
  // Go's `a.SigningKeys` is UNCONDITIONALLY seeded with the single default ES256 key at
  // `NewConfig()` time (`pkg/config/config.go:504-515`) — every resolved config carries it,
  // regardless of `auth.enabled`. It is only ever REPLACED by a configured
  // `signing_keys_path` file, and only when that file is actually read (gated on
  // `auth.enabled && signing_keys_path set`, `config.go:1087,1110-1116` — see
  // {@link legacyResolveConfiguredSigningKeys}). So `ResolveJWKS` (which iterates
  // `a.SigningKeys` with no `auth.enabled` gate of its own) always publishes either the
  // file's keys or this default — never neither. `GOTRUE_JWT_KEYS` signs with the same
  // default (`services/gotrue.service.ts`'s `LEGACY_GOTRUE_DEFAULT_SIGNING_KEY`), so the
  // two must never disagree on which key applies here.
  const signingKeys: ReadonlyArray<LegacyJwk> = legacyResolveConfiguredSigningKeys(
    config,
    workdir,
    projectEnvValues,
  ) ?? [LEGACY_DEFAULT_SIGNING_KEY];

  // Same fixed provider order + `SUPABASE_AUTH_THIRD_PARTY_<PROVIDER>_*` overrides as the
  // `thirdParty: Array<LegacyThirdPartyInput>` block in `legacyResolveLocalConfigValues` above,
  // but built as a `ThirdPartyProvidersLike` (every provider's full field set, including auth0's
  // `tenant_region`) rather than `LegacyThirdPartyInput` (a validation-only shape with no
  // `tenant_region` field) — {@link resolveThirdPartyIssuerUrl} needs the full set to build the
  // issuer URL, not just validate presence.
  const thirdParty: ThirdPartyProvidersLike = {
    firebase: {
      enabled: legacyEnvOverrideBool(
        "SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED",
        config.auth.third_party.firebase.enabled,
        "auth.third_party.firebase.enabled",
        projectEnvValues,
      ),
      project_id: legacyEnvOverride(
        "SUPABASE_AUTH_THIRD_PARTY_FIREBASE_PROJECT_ID",
        config.auth.third_party.firebase.project_id,
        projectEnvValues,
      ),
    },
    auth0: {
      enabled: legacyEnvOverrideBool(
        "SUPABASE_AUTH_THIRD_PARTY_AUTH0_ENABLED",
        config.auth.third_party.auth0.enabled,
        "auth.third_party.auth0.enabled",
        projectEnvValues,
      ),
      tenant: legacyEnvOverride(
        "SUPABASE_AUTH_THIRD_PARTY_AUTH0_TENANT",
        config.auth.third_party.auth0.tenant,
        projectEnvValues,
      ),
      tenant_region: legacyEnvOverride(
        "SUPABASE_AUTH_THIRD_PARTY_AUTH0_TENANT_REGION",
        config.auth.third_party.auth0.tenant_region,
        projectEnvValues,
      ),
    },
    aws_cognito: {
      enabled: legacyEnvOverrideBool(
        "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_ENABLED",
        config.auth.third_party.aws_cognito.enabled,
        "auth.third_party.aws_cognito.enabled",
        projectEnvValues,
      ),
      user_pool_id: legacyEnvOverride(
        "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_USER_POOL_ID",
        config.auth.third_party.aws_cognito.user_pool_id,
        projectEnvValues,
      ),
      user_pool_region: legacyEnvOverride(
        "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_USER_POOL_REGION",
        config.auth.third_party.aws_cognito.user_pool_region,
        projectEnvValues,
      ),
    },
    clerk: {
      enabled: legacyEnvOverrideBool(
        "SUPABASE_AUTH_THIRD_PARTY_CLERK_ENABLED",
        config.auth.third_party.clerk.enabled,
        "auth.third_party.clerk.enabled",
        projectEnvValues,
      ),
      domain: legacyEnvOverride(
        "SUPABASE_AUTH_THIRD_PARTY_CLERK_DOMAIN",
        config.auth.third_party.clerk.domain,
        projectEnvValues,
      ),
    },
    workos: {
      enabled: legacyEnvOverrideBool(
        "SUPABASE_AUTH_THIRD_PARTY_WORKOS_ENABLED",
        config.auth.third_party.workos.enabled,
        "auth.third_party.workos.enabled",
        projectEnvValues,
      ),
      issuer_url: legacyEnvOverride(
        "SUPABASE_AUTH_THIRD_PARTY_WORKOS_ISSUER_URL",
        config.auth.third_party.workos.issuer_url,
        projectEnvValues,
      ),
    },
  };

  // Go's `Auth.ThirdParty.validate()` (the "at most one enabled" + required-field checks
  // `resolveThirdPartyIssuerUrl` performs) only runs inside `Config.Validate`'s `if
  // c.Auth.Enabled` block (`config.go:1087-1153`) — but `ResolveJWKS`/`IssuerURL()` (this whole
  // function) is called UNCONDITIONALLY (`internal/start/start.go:274`), regardless of
  // `auth.enabled`. When auth is enabled, `legacyResolveLocalConfigValues`'s own gated
  // `validateAuthThirdPartyProviders`-equivalent check already ran first, so the validating
  // resolver here is safe/redundant-but-harmless. When auth is disabled, that earlier validation
  // is (correctly) skipped, so this function must NOT re-introduce it — using the unchecked,
  // no-throw `IssuerURL()`-only builder instead, matching Go exactly.
  const authEnabled = legacyEnvOverrideBool(
    "SUPABASE_AUTH_ENABLED",
    config.auth.enabled,
    "auth.enabled",
    projectEnvValues,
  );
  let issuerUrl: string | undefined;
  if (authEnabled) {
    try {
      issuerUrl = resolveThirdPartyIssuerUrl(thirdParty);
    } catch (cause) {
      throw new LegacyConfigValidateError(cause instanceof Error ? cause.message : String(cause));
    }
  } else {
    issuerUrl = thirdPartyIssuerUrlUnchecked(thirdParty);
  }

  const keys: unknown[] = [];
  // Go's `ResolveJWKS` only attempts the remote fetch when `issuerURL != ""`
  // (`apps/cli-go/pkg/config/config.go:1732`) — a provider's own `issuerURL()` can return the
  // empty string with no validation (e.g. workos's `issuerURL()` is a raw field read,
  // `config.go:1631-1632`), so an enabled-but-unconfigured third-party provider with
  // `auth.enabled = false` must be tolerated, not fetched.
  if (issuerUrl !== undefined && issuerUrl.length > 0) {
    try {
      keys.push(...(await resolveRemoteJwks(issuerUrl)));
    } catch (cause) {
      throw new LegacyConfigValidateError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  keys.push(...signingKeys.map(toPublicJwk));
  if (signingKeysPath === undefined || signingKeysPath.length === 0) {
    keys.push({ kty: "oct", k: Buffer.from(jwtSecret).toString("base64url") });
  }

  return JSON.stringify({ keys });
}
