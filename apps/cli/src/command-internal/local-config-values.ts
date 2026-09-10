import { readFileSync } from "node:fs";
import { basename } from "node:path";

import type { CliConfig } from "@supabase/config";
import { ENV_CAPTURE_REGEX } from "@supabase/config/internal";
import {
  defaultJwtSecret,
  defaultPublishableKey,
  defaultSecretKey,
} from "../shared/stack-constants.ts";
import { Schema } from "effect";

import {
  resolveRemoteJwks,
  resolveThirdPartyIssuerUrl,
  thirdPartyIssuerUrlUnchecked,
  toPublicJwk,
  type ThirdPartyProvidersLike,
} from "../shared/auth/jwks.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityFingerprintId,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { resolveApiExternalUrl } from "./api-url.ts";
import { makeRemoteWins, type RemoteOverridableKey } from "./db-config.toml-read.ts";
import { sanitizeProjectId } from "./docker-ids.ts";
import {
  apiTlsCertReadErrorMessage,
  apiTlsKeyReadErrorMessage,
  type AnalyticsInput,
  type ApiInput,
  type AuthInput,
  type CaptchaInput,
  ConfigValidateError,
  type ConfigValidationInput,
  type DbInput,
  emailContentPathReadErrorMessage,
  type ExperimentalInput,
  type HookInput,
  type LocalSmtpInput,
  type MfaFactorInput,
  parseGoBool,
  type PasskeyInput,
  resolveApiTlsPath,
  resolveEmailTemplateContentPath,
  resolveSigningKeysPath,
  signingKeysDecodeErrorMessage,
  signingKeysReadErrorMessage,
  type SmtpInput,
  type StudioInput,
  type ThirdPartyInput,
  validateResolvedConfig,
} from "./config-validate.ts";
import { DEFAULT_SIGNING_KEY, generateAsymmetricGoJwt, generateGoJwt, type Jwk } from "./go-jwt.ts";
import { collectDotenvPrivateKeys, decryptSecret, isEncryptedSecret } from "./vault-decrypt.ts";

/**
 * Resolves local-dev config values (URLs, ports, keys) for `status`/`stop`, filling in
 * literal defaults for fields `@supabase/config`'s schema doesn't model (`db.password`,
 * the S3 credential triple). Kept separate from `storage-credentials.ts`, which resolves
 * credentials for remote projects over HTTP instead.
 */

/** Local Postgres password; not configurable via config.toml. */
const DEFAULT_DB_PASSWORD = "postgres";

/** Local S3 credentials; not configurable via config.toml. */
const DEFAULT_S3_ACCESS_KEY_ID = "625729a08b95bf1b7ff351a663f3a23c";
const DEFAULT_S3_SECRET_ACCESS_KEY =
  "850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907";
const DEFAULT_S3_REGION = "local";

/**
 * Default Postgres root key. Exported so `start`'s Postgres container-spec builder can
 * reuse this literal instead of duplicating it; `db.root_key` isn't modeled in
 * `@supabase/config`'s schema, so it's resolved from the raw document like `jwtSecret`.
 */
export const POSTGRES_DEFAULT_ROOT_KEY =
  "d4dc5b6d4a1d6a10b2c1e76112c994d65db7cec380572cc1839624d4be3fa275";

export interface LocalConfigValues {
  readonly apiUrl: string;
  readonly apiPort: number;
  readonly dbPort: number;
  /** Already env-overridden `studio.port` (`SUPABASE_STUDIO_PORT`) — see `apiPort`/`dbPort` for the same pattern. */
  readonly studioPort: number;
  readonly rootKey: string;
  /** Already-resolved `studio.openai_api_key`: env-overridden, then decrypted if `encrypted:`. */
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
  /** Already env-overridden `analytics.backend` (`SUPABASE_ANALYTICS_BACKEND`), hard-validated like `LogflareBackend`. */
  readonly analyticsBackend: "postgres" | "bigquery";
  /** Already env-overridden `analytics.gcp_project_id` (`SUPABASE_ANALYTICS_GCP_PROJECT_ID`). */
  readonly gcpProjectId: string;
  /** Already env-overridden `analytics.gcp_project_number` (`SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER`). */
  readonly gcpProjectNumber: string;
  /** Already env-overridden `analytics.gcp_jwt_path` (`SUPABASE_ANALYTICS_GCP_JWT_PATH`). */
  readonly gcpJwtPath: string;
  /**
   * Sanitized, env-overridden project ID — the same value already validated internally,
   * exposed so callers needing it for Docker resource naming don't re-derive it separately.
   */
  readonly projectId: string;
  /** Already env-overridden `edge_runtime.deno_version` (`SUPABASE_EDGE_RUNTIME_DENO_VERSION`). */
  readonly edgeRuntimeDenoVersion: number;
}

/** Appends `path` to the resolved external URL; `apiExternalUrl` is always already defaulted. */
function apiUrlWithPath(apiExternalUrl: string, path: string): string {
  return `${apiExternalUrl}${path}`;
}

/**
 * Thrown by {@link resolveLocalConfigValues} when `auth.jwt_secret` is configured but too
 * short to sign with. Validated at config-load time, before any command renders output.
 */
export class InvalidJwtSecretError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "InvalidJwtSecretError";
  constructor() {
    super("Invalid config for auth.jwt_secret. Must be at least 16 characters");
    this.name = "InvalidJwtSecretError";
  }
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** Minimum `auth.jwt_secret` length. */
const MIN_JWT_SECRET_LENGTH = 16;

/**
 * Thrown by {@link envOverridePort} when a `SUPABASE_*_PORT` env/dotenv override doesn't
 * parse as a valid port. A malformed port override always hard-fails config loading; there's
 * no path that reaches `status`/`stop` with one.
 */
export class InvalidPortEnvOverrideError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "InvalidPortEnvOverrideError";
  constructor(dottedFieldPath: string, value: string) {
    super(`Invalid config for ${dottedFieldPath}: cannot parse "${value}" as a port`);
    this.name = "InvalidPortEnvOverrideError";
  }
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** Maximum valid port number. */
const MAX_PORT = 65535;

/**
 * Port-flavored sibling of {@link envOverride}/{@link envOverrideBool}. Unlike the boolean
 * sibling, which falls back to the configured value on a malformed override, a bad port
 * override throws {@link InvalidPortEnvOverrideError} instead.
 */
export function envOverridePort(
  name: string,
  configuredPort: number,
  dottedFieldPath: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  const value = envOverride(name, undefined, projectEnvValues);
  if (value === undefined) return configuredPort;
  const parsed = parseGoBaseZeroUint(value);
  if (parsed === undefined || parsed > BigInt(MAX_PORT)) {
    throw new InvalidPortEnvOverrideError(dottedFieldPath, value);
  }
  return Number(parsed);
}

/**
 * Resolves a `SUPABASE_<DOTTED_KEY>` override for a config field: checks `projectEnvValues`
 * (the project's already-resolved dotenv values) before falling back to `process.env`,
 * treating an empty value as unset.
 *
 * The resolved value can itself be an `env(VAR)` indirection (e.g. `env(API_ENABLED)`),
 * resolved with the same precedence; an unresolved indirection is returned as-is.
 */
export function envOverride(
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
 * Thrown by {@link envOverrideBool} when a `SUPABASE_*_ENABLED` (or other bool-typed)
 * env/dotenv override doesn't parse as an accepted bool spelling. A malformed bool override
 * always hard-fails config loading, same as {@link InvalidPortEnvOverrideError}.
 */
export class InvalidBoolEnvOverrideError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "InvalidBoolEnvOverrideError";
  constructor(dottedFieldPath: string, value: string) {
    super(`Invalid config for ${dottedFieldPath}: cannot parse "${value}" as a bool`);
    this.name = "InvalidBoolEnvOverrideError";
  }
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * Boolean-flavored sibling of {@link envOverride} for `SUPABASE_*` fields decoded as a
 * native bool (`api.tls.enabled`, `auth.enabled`, and other `<section>.enabled` gates). A
 * malformed override throws {@link InvalidBoolEnvOverrideError} rather than falling back
 * to `configured`.
 */
export function envOverrideBool(
  name: string,
  configured: boolean,
  dottedFieldPath: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): boolean {
  const value = envOverride(name, undefined, projectEnvValues);
  if (value === undefined) return configured;
  const parsed = parseGoBool(value);
  if (parsed === undefined) {
    throw new InvalidBoolEnvOverrideError(dottedFieldPath, value);
  }
  return parsed;
}

/** Thrown by {@link envOverrideAnalyticsBackend} when `SUPABASE_ANALYTICS_BACKEND` isn't `"postgres"` or `"bigquery"`. */
export class InvalidAnalyticsBackendEnvOverrideError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "InvalidAnalyticsBackendEnvOverrideError";
  constructor(dottedFieldPath: string, value: string) {
    super(
      `Invalid config for ${dottedFieldPath}: cannot parse "${value}" as one of "postgres", "bigquery"`,
    );
    this.name = "InvalidAnalyticsBackendEnvOverrideError";
  }
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * Validates the override-or-configured value against the closed `postgres`/`bigquery` set,
 * checking both sources with a single check so the return type narrows correctly.
 * `skipEnvOverride` lets a matched remote-config value win over a conflicting
 * `SUPABASE_ANALYTICS_BACKEND`.
 */
export function envOverrideAnalyticsBackend(
  configured: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
  skipEnvOverride = false,
): "postgres" | "bigquery" {
  const value = skipEnvOverride
    ? configured
    : (envOverride("SUPABASE_ANALYTICS_BACKEND", undefined, projectEnvValues) ?? configured);
  if (value !== "postgres" && value !== "bigquery") {
    throw new InvalidAnalyticsBackendEnvOverrideError("analytics.backend", value);
  }
  return value;
}

/** Thrown by {@link envOverrideRealtimeIpVersion} when `SUPABASE_REALTIME_IP_VERSION` isn't `"IPv4"` or `"IPv6"`. */
export class InvalidRealtimeIpVersionEnvOverrideError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "InvalidRealtimeIpVersionEnvOverrideError";
  constructor(dottedFieldPath: string, value: string) {
    super(
      `Invalid config for ${dottedFieldPath}: cannot parse "${value}" as one of "IPv4", "IPv6"`,
    );
    this.name = "InvalidRealtimeIpVersionEnvOverrideError";
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

export function envOverrideRealtimeIpVersion(
  configured: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): "IPv4" | "IPv6" {
  const value =
    envOverride("SUPABASE_REALTIME_IP_VERSION", undefined, projectEnvValues) ?? configured;
  if (value !== "IPv4" && value !== "IPv6") {
    throw new InvalidRealtimeIpVersionEnvOverrideError("realtime.ip_version", value);
  }
  return value;
}

/** `SUPABASE_REALTIME_MAX_HEADER_LENGTH` — see {@link envOverrideUint}. */
export function envOverrideRealtimeMaxHeaderLength(
  configured: number,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  return envOverrideUint(
    "SUPABASE_REALTIME_MAX_HEADER_LENGTH",
    "realtime.max_header_length",
    configured,
    projectEnvValues,
  );
}

/** `SUPABASE_API_MAX_ROWS` — see {@link envOverrideUint}. */
export function envOverrideApiMaxRows(
  configured: number,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  return envOverrideUint("SUPABASE_API_MAX_ROWS", "api.max_rows", configured, projectEnvValues);
}

/** Thrown by {@link envOverridePoolMode} when `SUPABASE_DB_POOLER_POOL_MODE` isn't `"transaction"` or `"session"`. */
export class InvalidPoolModeEnvOverrideError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "InvalidPoolModeEnvOverrideError";
  constructor(dottedFieldPath: string, value: string) {
    super(
      `Invalid config for ${dottedFieldPath}: cannot parse "${value}" as one of "transaction", "session"`,
    );
    this.name = "InvalidPoolModeEnvOverrideError";
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

export function envOverridePoolMode(
  configured: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): "transaction" | "session" {
  const value =
    envOverride("SUPABASE_DB_POOLER_POOL_MODE", undefined, projectEnvValues) ?? configured;
  if (value !== "transaction" && value !== "session") {
    throw new InvalidPoolModeEnvOverrideError("db.pooler.pool_mode", value);
  }
  return value;
}

/** Thrown by {@link envOverrideEdgeRuntimePolicy} when `SUPABASE_EDGE_RUNTIME_POLICY` isn't `"per_worker"` or `"oneshot"`. */
export class InvalidEdgeRuntimePolicyEnvOverrideError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "InvalidEdgeRuntimePolicyEnvOverrideError";
  constructor(dottedFieldPath: string, value: string) {
    super(
      `Invalid config for ${dottedFieldPath}: cannot parse "${value}" as one of "per_worker", "oneshot"`,
    );
    this.name = "InvalidEdgeRuntimePolicyEnvOverrideError";
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

export function envOverrideEdgeRuntimePolicy(
  configured: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): "per_worker" | "oneshot" {
  const value =
    envOverride("SUPABASE_EDGE_RUNTIME_POLICY", undefined, projectEnvValues) ?? configured;
  if (value !== "per_worker" && value !== "oneshot") {
    throw new InvalidEdgeRuntimePolicyEnvOverrideError("edge_runtime.policy", value);
  }
  return value;
}

/** `SUPABASE_DB_POOLER_DEFAULT_POOL_SIZE` — see {@link envOverrideUint}. */
export function envOverrideDefaultPoolSize(
  configured: number,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  return envOverrideUint(
    "SUPABASE_DB_POOLER_DEFAULT_POOL_SIZE",
    "db.pooler.default_pool_size",
    configured,
    projectEnvValues,
  );
}

/** `SUPABASE_DB_POOLER_MAX_CLIENT_CONN` — see {@link envOverrideUint}. */
export function envOverrideMaxClientConn(
  configured: number,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  return envOverrideUint(
    "SUPABASE_DB_POOLER_MAX_CLIENT_CONN",
    "db.pooler.max_client_conn",
    configured,
    projectEnvValues,
  );
}

/**
 * Decrypts a resolved auth identity-key field when it's a dotenvx `encrypted:` value; an
 * undecryptable value fails config loading rather than passing through unusable key material.
 * Applied after {@link envOverride} so an env-sourced override is decrypted too, not just
 * the config.toml value.
 */
export function decryptAuthSecret(
  value: string | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (value === undefined || !isEncryptedSecret(value)) return value;
  const dotenvPrivateKeys = collectDotenvPrivateKeys({ ...projectEnvValues, ...process.env });
  const decrypted = decryptSecret(value, dotenvPrivateKeys);
  if (!decrypted.ok) {
    throw new ConfigValidateError(`failed to parse config: ${decrypted.error}`);
  }
  return decrypted.value;
}

/**
 * Resolves `[auth.email.smtp]`'s full field set, including a presence-based `enabled`
 * default `@supabase/config`'s schema can't express (it always decodes `enabled: false`
 * when the key is absent from a present table). Exported so `start.handler.ts`'s GoTrue env
 * resolution reuses this instead of re-deriving it.
 */
export function resolveAuthEmailSmtp(
  authDocument: Readonly<Record<string, unknown>> | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
  /**
   * Fields whose `envOverride`/`envOverrideBool`/`envOverridePort` calls below can throw on
   * a malformed value (directly, or via {@link decryptAuthSecret}) belong in this set so a
   * matched remote block's value wins instead of aborting on an unrelated bad env var.
   * Defaults to empty for callers with no `[remotes.<ref>]` block to match against.
   */
  remoteOverrideKeys: ReadonlySet<string> = new Set(),
): (SmtpInput & { readonly senderName: string | undefined }) | undefined {
  const remoteWins = makeRemoteWins(remoteOverrideKeys);
  const smtpDoc = asRecord(asRecord(authDocument?.["email"])?.["smtp"]);
  if (smtpDoc === undefined) return undefined;
  return {
    enabled: remoteWins("auth.email.smtp.enabled")
      ? smtpDoc["enabled"] === undefined
        ? true
        : smtpDoc["enabled"] === true
      : envOverrideBool(
          "SUPABASE_AUTH_EMAIL_SMTP_ENABLED",
          smtpDoc["enabled"] === undefined ? true : smtpDoc["enabled"] === true,
          "auth.email.smtp.enabled",
          projectEnvValues,
        ),
    host: remoteWins("auth.email.smtp.host")
      ? typeof smtpDoc["host"] === "string"
        ? smtpDoc["host"]
        : ""
      : (envOverride(
          "SUPABASE_AUTH_EMAIL_SMTP_HOST",
          typeof smtpDoc["host"] === "string" ? smtpDoc["host"] : "",
          projectEnvValues,
        ) ?? ""),
    port: remoteWins("auth.email.smtp.port")
      ? typeof smtpDoc["port"] === "number"
        ? smtpDoc["port"]
        : 0
      : envOverridePort(
          "SUPABASE_AUTH_EMAIL_SMTP_PORT",
          typeof smtpDoc["port"] === "number" ? smtpDoc["port"] : 0,
          "auth.email.smtp.port",
          projectEnvValues,
        ),
    user: remoteWins("auth.email.smtp.user")
      ? typeof smtpDoc["user"] === "string"
        ? smtpDoc["user"]
        : ""
      : (envOverride(
          "SUPABASE_AUTH_EMAIL_SMTP_USER",
          typeof smtpDoc["user"] === "string" ? smtpDoc["user"] : "",
          projectEnvValues,
        ) ?? ""),
    // Decrypted like other secrets. `auth.email.smtp.pass` is in `ENV_OVERRIDABLE_KEYS` so a
    // malformed ambient override can't abort decryption when a remote block already set it.
    pass: remoteWins("auth.email.smtp.pass")
      ? (decryptAuthSecret(
          typeof smtpDoc["pass"] === "string" ? smtpDoc["pass"] : "",
          projectEnvValues,
        ) ?? "")
      : (decryptAuthSecret(
          envOverride(
            "SUPABASE_AUTH_EMAIL_SMTP_PASS",
            typeof smtpDoc["pass"] === "string" ? smtpDoc["pass"] : "",
            projectEnvValues,
          ) ?? "",
          projectEnvValues,
        ) ?? ""),
    adminEmail: remoteWins("auth.email.smtp.admin_email")
      ? typeof smtpDoc["admin_email"] === "string"
        ? smtpDoc["admin_email"]
        : ""
      : (envOverride(
          "SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL",
          typeof smtpDoc["admin_email"] === "string" ? smtpDoc["admin_email"] : "",
          projectEnvValues,
        ) ?? ""),
    senderName: remoteWins("auth.email.smtp.sender_name")
      ? typeof smtpDoc["sender_name"] === "string"
        ? smtpDoc["sender_name"]
        : undefined
      : envOverride(
          "SUPABASE_AUTH_EMAIL_SMTP_SENDER_NAME",
          typeof smtpDoc["sender_name"] === "string" ? smtpDoc["sender_name"] : undefined,
          projectEnvValues,
        ),
  };
}

/**
 * `auth.captcha` validation requires both `provider` and `secret` when the section is
 * enabled. Unlike `auth.passkey`/`auth.webauthn`, `config.auth.captcha` never decodes to
 * `undefined` when `[auth.captcha]` is absent, so presence is read from the raw
 * `authDocument` instead. Hoisted so `start.handler.ts`'s GoTrue env resolution shares this
 * same resolved value.
 */
export function resolveAuthCaptcha(
  authDocument: Readonly<Record<string, unknown>> | undefined,
  captcha: CliConfig["auth"]["captcha"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
  /**
   * Fields whose `envOverride`/`envOverrideBool` calls below can throw on a malformed value
   * (directly, or via {@link decryptAuthSecret}) belong in this set so a matched remote
   * block's value wins instead of aborting on an unrelated bad env var. Defaults to empty for
   * callers with no `[remotes.<ref>]` block to match against.
   */
  remoteOverrideKeys: ReadonlySet<string> = new Set(),
): CaptchaInput | undefined {
  const remoteWins = makeRemoteWins(remoteOverrideKeys);
  const captchaDoc = asRecord(authDocument?.["captcha"]);
  return captcha
    ? {
        enabled: remoteWins("auth.captcha.enabled")
          ? (captcha.enabled ?? false)
          : captchaDoc !== undefined
            ? envOverrideBool(
                "SUPABASE_AUTH_CAPTCHA_ENABLED",
                captcha.enabled ?? false,
                "auth.captcha.enabled",
                projectEnvValues,
              )
            : (captcha.enabled ?? false),
        provider: remoteWins("auth.captcha.provider")
          ? captcha.provider
          : captchaDoc !== undefined
            ? envOverride("SUPABASE_AUTH_CAPTCHA_PROVIDER", captcha.provider, projectEnvValues)
            : captcha.provider,
        // Decrypted like `auth.email.smtp.pass`. `auth.captcha.secret` is in
        // `ENV_OVERRIDABLE_KEYS` so a malformed ambient override can't abort decryption when a
        // remote block already set it.
        secret: decryptAuthSecret(
          remoteWins("auth.captcha.secret")
            ? captcha.secret
            : captchaDoc !== undefined
              ? envOverride("SUPABASE_AUTH_CAPTCHA_SECRET", captcha.secret, projectEnvValues)
              : captcha.secret,
          projectEnvValues,
        ),
      }
    : undefined;
}

/**
 * Resolves the signing secret from the already-resolved `auth.jwt_secret`: empty falls back
 * to {@link defaultJwtSecret}, shorter than {@link MIN_JWT_SECRET_LENGTH} throws
 * {@link InvalidJwtSecretError}.
 */
export function resolveJwtSecret(configured: string | undefined): string {
  if (configured === undefined || configured.length === 0) return defaultJwtSecret;
  if (configured.length < MIN_JWT_SECRET_LENGTH) {
    throw new InvalidJwtSecretError();
  }
  return configured;
}

function resolveOpaqueKey(configured: string | undefined, fallback: string): string {
  return configured !== undefined && configured.length > 0 ? configured : fallback;
}

function resolveSignedKey(
  configured: string | undefined,
  jwtSecret: string,
  signingKey: Jwk | undefined,
  role: "anon" | "service_role",
): string {
  if (configured !== undefined && configured.length > 0) return configured;
  return signingKey !== undefined
    ? generateAsymmetricGoJwt(signingKey, role)
    : generateGoJwt(jwtSecret, role);
}

/** JWK fields, matching {@link Jwk}. */
const JwkSchema = Schema.Struct({
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
const decodeJwks = Schema.decodeUnknownSync(Schema.Array(JwkSchema));

/**
 * Reads and JSON-decodes `signingKeysPath` into an array of {@link Jwk}, using `node:fs`
 * directly (not the `FileSystem` Effect service) to keep this a plain synchronous resolver
 * for a rarely-configured field. Callers must only invoke this when auth is enabled.
 */
function readSigningKeysFile(workdir: string, signingKeysPath: string): ReadonlyArray<Jwk> {
  const absolutePath = resolveSigningKeysPath(workdir, signingKeysPath);

  let contents: string;
  try {
    contents = readFileSync(absolutePath, "utf8");
  } catch (cause) {
    throw new ConfigValidateError(signingKeysReadErrorMessage(cause));
  }

  try {
    // `Jwk.key_ops` is mutable (required for Node's `createPrivateKey`/`JsonWebKey` input), so
    // it's copied into a fresh array rather than widening the schema's readonly output type.
    return decodeJwks(JSON.parse(contents)).map((jwk) => ({
      ...jwk,
      key_ops: jwk.key_ops === undefined ? undefined : [...jwk.key_ops],
    }));
  } catch (cause) {
    throw new ConfigValidateError(signingKeysDecodeErrorMessage(cause));
  }
}

/** See {@link readSigningKeysFile}. */
function loadSigningKeys(workdir: string, signingKeysPath: string): ReadonlyArray<Jwk> {
  return readSigningKeysFile(workdir, signingKeysPath);
}

/**
 * Returns the parsed signing keys only when auth is enabled and a path is configured;
 * `undefined` otherwise, so callers fall back to their own default key shape. Shared by
 * {@link resolveLocalJwks} and `start.handler.ts`'s `GOTRUE_JWT_KEYS` so both resolvers agree
 * on which key(s) apply. `remoteOverrideKeys` lets a matched remote block win over a
 * conflicting env override on `auth.enabled`/`auth.signing_keys_path`.
 */
export function resolveConfiguredSigningKeys(
  config: CliConfig,
  workdir: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
  remoteOverrideKeys: ReadonlySet<string> = new Set(),
): ReadonlyArray<Jwk> | undefined {
  const remoteWins = makeRemoteWins(remoteOverrideKeys);
  const authEnabled = remoteWins("auth.enabled")
    ? config.auth.enabled
    : envOverrideBool(
        "SUPABASE_AUTH_ENABLED",
        config.auth.enabled,
        "auth.enabled",
        projectEnvValues,
      );
  const signingKeysPath = remoteWins("auth.signing_keys_path")
    ? config.auth.signing_keys_path
    : envOverride(
        "SUPABASE_AUTH_SIGNING_KEYS_PATH",
        config.auth.signing_keys_path,
        projectEnvValues,
      );
  return authEnabled && signingKeysPath !== undefined && signingKeysPath.length > 0
    ? loadSigningKeys(workdir, signingKeysPath)
    : undefined;
}

/**
 * Confirms `api.tls.cert`/`.key` are readable when both are configured; the "exactly one set"
 * check lives in `validateResolvedConfig`. Unlike {@link readSigningKeysFile}'s
 * `signing_keys_path`, both paths join with the `supabase/` dir without an absolute-path guard.
 */
function readApiTlsFiles(
  workdir: string,
  certPath: string | undefined,
  keyPath: string | undefined,
): void {
  if (certPath === undefined || certPath.length === 0) return;
  if (keyPath === undefined || keyPath.length === 0) return;

  try {
    readFileSync(resolveApiTlsPath(workdir, certPath), "utf8");
  } catch (cause) {
    throw new ConfigValidateError(apiTlsCertReadErrorMessage(cause));
  }
  try {
    readFileSync(resolveApiTlsPath(workdir, keyPath), "utf8");
  } catch (cause) {
    throw new ConfigValidateError(apiTlsKeyReadErrorMessage(cause));
  }
}

/**
 * One `[auth.email.template.<name>]` entry, already env-override-resolved. `subject` is
 * `string | undefined` rather than a plain `string` — see {@link resolveAuthEmail}'s doc
 * comment for why.
 */
interface ResolvedAuthEmailTemplate {
  readonly subject: string | undefined;
  readonly content_path: string;
  readonly content_present: boolean;
}

/** One `[auth.email.notification.<name>]` entry — see {@link ResolvedAuthEmailTemplate}. */
interface ResolvedAuthEmailNotification {
  readonly enabled: boolean;
  readonly subject: string | undefined;
  readonly content_path: string;
  readonly content_present: boolean;
}

/**
 * {@link resolveAuthEmail}'s return type — identical to `CliConfig["auth"]["email"]`
 * except each `template`/`notification` entry's `subject` is `string | undefined` instead of a
 * plain `string`.
 */
export type ResolvedAuthEmail = Omit<CliConfig["auth"]["email"], "template" | "notification"> & {
  readonly template: Readonly<Record<string, ResolvedAuthEmailTemplate>>;
  readonly notification: Readonly<Record<string, ResolvedAuthEmailNotification>>;
};

/**
 * Resolves `auth.email`'s full field set, including per-`template`/`notification` overrides.
 * Each entry's `subject` needs a raw-document read to tell an explicit `subject = ""` apart
 * from an absent key, since both decode to the same `""`; an env override always wins over
 * either case. Shared by `start.handler.ts`'s GoTrue env builder and its email-template
 * content read.
 */
export function resolveAuthEmail(
  email: CliConfig["auth"]["email"],
  authDocument: Record<string, unknown> | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
  /**
   * Fields whose `envOverride`/`envOverrideBool` calls (here or in the caller-side file read
   * for `content_path`) can throw on a malformed value belong in this set so a matched remote
   * block's value wins instead of aborting on an unrelated bad env var. Covers top-level
   * `auth.email.*` leaves as well as each `template.<name>.*`/`notification.<name>.*` leaf.
   */
  remoteOverrideKeys: ReadonlySet<string> = new Set(),
): ResolvedAuthEmail {
  const remoteWins = makeRemoteWins(remoteOverrideKeys);
  const emailDoc = asRecord(authDocument?.["email"]);
  const templateDoc = asRecord(emailDoc?.["template"]);
  const notificationDoc = asRecord(emailDoc?.["notification"]);

  const template: Record<string, ResolvedAuthEmailTemplate> = {};
  for (const [name, tmpl] of Object.entries(email.template)) {
    const envPrefix = `SUPABASE_AUTH_EMAIL_TEMPLATE_${name.toUpperCase()}`;
    const rawSubjectPresent = asRecord(templateDoc?.[name])?.["subject"] !== undefined;
    const envSubject = remoteWins(`auth.email.template.${name}.subject`)
      ? undefined
      : envOverride(`${envPrefix}_SUBJECT`, undefined, projectEnvValues);
    template[name] = {
      subject: envSubject ?? (rawSubjectPresent ? tmpl.subject : undefined),
      content_path: remoteWins(`auth.email.template.${name}.content_path`)
        ? tmpl.content_path
        : (envOverride(`${envPrefix}_CONTENT_PATH`, tmpl.content_path, projectEnvValues) ??
          tmpl.content_path),
      // `content` counts as present when set via TOML or the `_CONTENT` env override;
      // {@link readAuthEmailTemplateContent} rejects it below unless `content_path` is also set.
      content_present:
        asRecord(templateDoc?.[name])?.["content"] !== undefined ||
        (remoteWins(`auth.email.template.${name}.content`)
          ? false
          : envOverride(`${envPrefix}_CONTENT`, undefined, projectEnvValues) !== undefined),
    };
  }

  const notification: Record<string, ResolvedAuthEmailNotification> = {};
  for (const [name, tmpl] of Object.entries(email.notification)) {
    const envPrefix = `SUPABASE_AUTH_EMAIL_NOTIFICATION_${name.toUpperCase()}`;
    const rawSubjectPresent = asRecord(notificationDoc?.[name])?.["subject"] !== undefined;
    const envSubject = remoteWins(`auth.email.notification.${name}.subject`)
      ? undefined
      : envOverride(`${envPrefix}_SUBJECT`, undefined, projectEnvValues);
    notification[name] = {
      enabled: remoteWins(`auth.email.notification.${name}.enabled`)
        ? tmpl.enabled
        : envOverrideBool(
            `${envPrefix}_ENABLED`,
            tmpl.enabled,
            `auth.email.notification.${name}.enabled`,
            projectEnvValues,
          ),
      subject: envSubject ?? (rawSubjectPresent ? tmpl.subject : undefined),
      content_path: remoteWins(`auth.email.notification.${name}.content_path`)
        ? tmpl.content_path
        : (envOverride(`${envPrefix}_CONTENT_PATH`, tmpl.content_path, projectEnvValues) ??
          tmpl.content_path),
      // Same `_CONTENT` env-presence fold as the template loop above.
      content_present:
        asRecord(notificationDoc?.[name])?.["content"] !== undefined ||
        (remoteWins(`auth.email.notification.${name}.content`)
          ? false
          : envOverride(`${envPrefix}_CONTENT`, undefined, projectEnvValues) !== undefined),
    };
  }

  return {
    ...email,
    enable_signup: remoteWins("auth.email.enable_signup")
      ? email.enable_signup
      : envOverrideBool(
          "SUPABASE_AUTH_EMAIL_ENABLE_SIGNUP",
          email.enable_signup,
          "auth.email.enable_signup",
          projectEnvValues,
        ),
    double_confirm_changes: remoteWins("auth.email.double_confirm_changes")
      ? email.double_confirm_changes
      : envOverrideBool(
          "SUPABASE_AUTH_EMAIL_DOUBLE_CONFIRM_CHANGES",
          email.double_confirm_changes,
          "auth.email.double_confirm_changes",
          projectEnvValues,
        ),
    enable_confirmations: remoteWins("auth.email.enable_confirmations")
      ? email.enable_confirmations
      : envOverrideBool(
          "SUPABASE_AUTH_EMAIL_ENABLE_CONFIRMATIONS",
          email.enable_confirmations,
          "auth.email.enable_confirmations",
          projectEnvValues,
        ),
    secure_password_change: remoteWins("auth.email.secure_password_change")
      ? email.secure_password_change
      : envOverrideBool(
          "SUPABASE_AUTH_EMAIL_SECURE_PASSWORD_CHANGE",
          email.secure_password_change,
          "auth.email.secure_password_change",
          projectEnvValues,
        ),
    max_frequency: remoteWins("auth.email.max_frequency")
      ? email.max_frequency
      : (envOverride("SUPABASE_AUTH_EMAIL_MAX_FREQUENCY", email.max_frequency, projectEnvValues) ??
        email.max_frequency),
    otp_length: remoteWins("auth.email.otp_length")
      ? email.otp_length
      : envOverrideUint(
          "SUPABASE_AUTH_EMAIL_OTP_LENGTH",
          "auth.email.otp_length",
          email.otp_length,
          projectEnvValues,
        ),
    otp_expiry: remoteWins("auth.email.otp_expiry")
      ? email.otp_expiry
      : envOverrideUint(
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
 * Reads each template/notification's content file, run only when auth is enabled. Every
 * template is checked unconditionally; a notification only when it's itself enabled. The
 * `content`-vs-`content_path` exclusivity and path resolution live in
 * `resolveEmailTemplateContentPath`; this only performs the read once a path comes back.
 */
function readAuthEmailTemplateContent(email: ResolvedAuthEmail, workdir: string): void {
  for (const [name, tmpl] of Object.entries(email.template)) {
    const path = resolveEmailTemplateContentPath({
      section: "template",
      name,
      contentPath: tmpl.content_path,
      contentPresent: tmpl.content_present,
      base: workdir,
    });
    if (path === undefined) continue;
    try {
      readFileSync(path, "utf8");
    } catch (cause) {
      throw new ConfigValidateError(emailContentPathReadErrorMessage("template", name, cause));
    }
  }
  for (const [name, tmpl] of Object.entries(email.notification)) {
    if (!tmpl.enabled) continue;
    const path = resolveEmailTemplateContentPath({
      section: "notification",
      name,
      contentPath: tmpl.content_path,
      contentPresent: tmpl.content_present,
      base: workdir,
    });
    if (path === undefined) continue;
    try {
      readFileSync(path, "utf8");
    } catch (cause) {
      throw new ConfigValidateError(emailContentPathReadErrorMessage("notification", name, cause));
    }
  }
}

// Every field routed through {@link envOverrideUint} is an unsigned 64-bit value; comparing
// as `BigInt` (not `Number`) avoids precision loss near `2^64`.
const UINT_MAX = 18446744073709551615n; // 2^64 - 1

/**
 * Base-0 unsigned integer literal parsing (`0b`/`0o`/`0x` prefixes, and a bare leading zero
 * also meaning octal — so `"010"` parses as `8`), matching Go's `strconv.ParseUint(str, 0, …)`
 * grammar. Underscores between digits are allowed; a leading sign is never accepted. Returns
 * `undefined` for anything invalid instead of throwing, leaving bit-width bounds to the caller.
 */
function parseGoBaseZeroUint(value: string): bigint | undefined {
  if (value.length === 0 || value.startsWith("+") || value.startsWith("-")) return undefined;

  let literal: string | undefined;
  if (/^0[bB](_?[01])+$/.test(value)) {
    literal = `0b${value.slice(2).replaceAll("_", "")}`;
  } else if (/^0[oO](_?[0-7])+$/.test(value)) {
    literal = `0o${value.slice(2).replaceAll("_", "")}`;
  } else if (/^0[xX](_?[0-9a-fA-F])+$/.test(value)) {
    literal = `0x${value.slice(2).replaceAll("_", "")}`;
  } else if (value.startsWith("0") && value.length > 1) {
    // A bare leading zero is always octal, with no fallback to decimal — `"08"`/`"09"` are
    // rejected, not read as decimal 8/9.
    literal = /^[0-7](_?[0-7])*$/.test(value) ? `0o${value.replaceAll("_", "")}` : undefined;
  } else {
    literal = /^[0-9](_?[0-9])*$/.test(value) ? value.replaceAll("_", "") : undefined;
  }
  if (literal === undefined) return undefined;

  try {
    // `BigInt` natively parses `0b`/`0o`/`0x`-prefixed literals in the corresponding base.
    return BigInt(literal);
  } catch {
    return undefined;
  }
}

/**
 * `SUPABASE_<NAME>` sibling of {@link envOverridePort} for uncapped `uint`-typed fields
 * (`db.major_version`, `auth.jwt_expiry`, …). Parses with {@link parseGoBaseZeroUint} and
 * folds an invalid or out-of-{@link UINT_MAX} override into the generic "Invalid <field>"
 * error message.
 */
export function envOverrideUint(
  name: string,
  dottedFieldPath: string,
  configured: number,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  const value = envOverride(name, undefined, projectEnvValues);
  if (value === undefined) return configured;
  const parsed = parseGoBaseZeroUint(value);
  if (parsed === undefined || parsed > UINT_MAX) {
    throw new Error(`Failed reading config: Invalid ${dottedFieldPath}: ${value}.`);
  }
  return Number(parsed);
}

/** `SUPABASE_DB_MAJOR_VERSION` — see {@link envOverrideUint}. */
export function envOverrideMajorVersion(
  configured: number,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  return envOverrideUint(
    "SUPABASE_DB_MAJOR_VERSION",
    "db.major_version",
    configured,
    projectEnvValues,
  );
}

/** `SUPABASE_EDGE_RUNTIME_DENO_VERSION` — see {@link envOverrideUint}. */
export function envOverrideDenoVersion(
  configured: number,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  return envOverrideUint(
    "SUPABASE_EDGE_RUNTIME_DENO_VERSION",
    "edge_runtime.deno_version",
    configured,
    projectEnvValues,
  );
}

/**
 * Optional-uint sibling of {@link envOverrideUint} for `db.settings.*` fields
 * (`max_connections`, `max_wal_senders`, …) that are left unset, not defaulted, when
 * absent from config.toml. `configured`/the return value stay `number | undefined` to
 * preserve that state through an override miss.
 */
function envOverrideOptionalUint(
  name: string,
  dottedFieldPath: string,
  configured: number | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number | undefined {
  const value = envOverride(name, undefined, projectEnvValues);
  if (value === undefined) return configured;
  const parsed = parseGoBaseZeroUint(value);
  if (parsed === undefined || parsed > UINT_MAX) {
    throw new Error(`Failed reading config: Invalid ${dottedFieldPath}: ${value}.`);
  }
  return Number(parsed);
}

/**
 * Optional-bool sibling of {@link envOverrideBool} for `db.settings.track_commit_timestamp`,
 * the only bool field in this file left unset (not defaulted) when absent.
 */
function envOverrideOptionalBool(
  name: string,
  configured: boolean | undefined,
  dottedFieldPath: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): boolean | undefined {
  const value = envOverride(name, undefined, projectEnvValues);
  if (value === undefined) return configured;
  const parsed = parseGoBool(value);
  if (parsed === undefined) {
    throw new InvalidBoolEnvOverrideError(dottedFieldPath, value);
  }
  return parsed;
}

/** Thrown by {@link resolveDbSettingsEnvOverrides} when `SUPABASE_DB_SETTINGS_SESSION_REPLICATION_ROLE` isn't `"origin"`, `"replica"`, or `"local"`. */
export class InvalidSessionReplicationRoleEnvOverrideError extends Error {
  static readonly [ErrorActionabilityFingerprintId] =
    "InvalidSessionReplicationRoleEnvOverrideError";
  constructor(dottedFieldPath: string, value: string) {
    super(
      `Invalid config for ${dottedFieldPath}: cannot parse "${value}" as one of "origin", "replica", "local"`,
    );
    this.name = "InvalidSessionReplicationRoleEnvOverrideError";
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * Enum-flavored sibling of {@link envOverride} for `db.settings.session_replication_role`.
 * Unlike {@link envOverrideAnalyticsBackend}, `configured` (and the return value) may
 * be `undefined` — validation only runs once a value is actually present.
 */
function envOverrideSessionReplicationRole(
  configured: string | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): "origin" | "replica" | "local" | undefined {
  const value = envOverride(
    "SUPABASE_DB_SETTINGS_SESSION_REPLICATION_ROLE",
    configured,
    projectEnvValues,
  );
  if (value === undefined) return undefined;
  if (value !== "origin" && value !== "replica" && value !== "local") {
    throw new InvalidSessionReplicationRoleEnvOverrideError(
      "db.settings.session_replication_role",
      value,
    );
  }
  return value;
}

/**
 * Resolves every `db.settings.*` sub-field to its env-overridden value before
 * `postgresSettingsToPostgresConfig` serializes `postgresql.conf`. `remoteOverrideKeys`
 * lets a matched remote block's value win over a conflicting `SUPABASE_DB_SETTINGS_*` var,
 * same as elsewhere in this file.
 */
export function resolveDbSettingsEnvOverrides(
  settings: CliConfig["db"]["settings"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
  remoteOverrideKeys: ReadonlySet<string> = new Set(),
): NonNullable<CliConfig["db"]["settings"]> {
  const remoteWins = makeRemoteWins(remoteOverrideKeys);
  return {
    effective_cache_size: remoteWins("db.settings.effective_cache_size")
      ? settings?.effective_cache_size
      : envOverride(
          "SUPABASE_DB_SETTINGS_EFFECTIVE_CACHE_SIZE",
          settings?.effective_cache_size,
          projectEnvValues,
        ),
    logical_decoding_work_mem: remoteWins("db.settings.logical_decoding_work_mem")
      ? settings?.logical_decoding_work_mem
      : envOverride(
          "SUPABASE_DB_SETTINGS_LOGICAL_DECODING_WORK_MEM",
          settings?.logical_decoding_work_mem,
          projectEnvValues,
        ),
    maintenance_work_mem: remoteWins("db.settings.maintenance_work_mem")
      ? settings?.maintenance_work_mem
      : envOverride(
          "SUPABASE_DB_SETTINGS_MAINTENANCE_WORK_MEM",
          settings?.maintenance_work_mem,
          projectEnvValues,
        ),
    max_connections: remoteWins("db.settings.max_connections")
      ? settings?.max_connections
      : envOverrideOptionalUint(
          "SUPABASE_DB_SETTINGS_MAX_CONNECTIONS",
          "db.settings.max_connections",
          settings?.max_connections,
          projectEnvValues,
        ),
    max_locks_per_transaction: remoteWins("db.settings.max_locks_per_transaction")
      ? settings?.max_locks_per_transaction
      : envOverrideOptionalUint(
          "SUPABASE_DB_SETTINGS_MAX_LOCKS_PER_TRANSACTION",
          "db.settings.max_locks_per_transaction",
          settings?.max_locks_per_transaction,
          projectEnvValues,
        ),
    max_parallel_maintenance_workers: remoteWins("db.settings.max_parallel_maintenance_workers")
      ? settings?.max_parallel_maintenance_workers
      : envOverrideOptionalUint(
          "SUPABASE_DB_SETTINGS_MAX_PARALLEL_MAINTENANCE_WORKERS",
          "db.settings.max_parallel_maintenance_workers",
          settings?.max_parallel_maintenance_workers,
          projectEnvValues,
        ),
    max_parallel_workers: remoteWins("db.settings.max_parallel_workers")
      ? settings?.max_parallel_workers
      : envOverrideOptionalUint(
          "SUPABASE_DB_SETTINGS_MAX_PARALLEL_WORKERS",
          "db.settings.max_parallel_workers",
          settings?.max_parallel_workers,
          projectEnvValues,
        ),
    max_parallel_workers_per_gather: remoteWins("db.settings.max_parallel_workers_per_gather")
      ? settings?.max_parallel_workers_per_gather
      : envOverrideOptionalUint(
          "SUPABASE_DB_SETTINGS_MAX_PARALLEL_WORKERS_PER_GATHER",
          "db.settings.max_parallel_workers_per_gather",
          settings?.max_parallel_workers_per_gather,
          projectEnvValues,
        ),
    max_replication_slots: remoteWins("db.settings.max_replication_slots")
      ? settings?.max_replication_slots
      : envOverrideOptionalUint(
          "SUPABASE_DB_SETTINGS_MAX_REPLICATION_SLOTS",
          "db.settings.max_replication_slots",
          settings?.max_replication_slots,
          projectEnvValues,
        ),
    max_slot_wal_keep_size: remoteWins("db.settings.max_slot_wal_keep_size")
      ? settings?.max_slot_wal_keep_size
      : envOverride(
          "SUPABASE_DB_SETTINGS_MAX_SLOT_WAL_KEEP_SIZE",
          settings?.max_slot_wal_keep_size,
          projectEnvValues,
        ),
    max_standby_archive_delay: remoteWins("db.settings.max_standby_archive_delay")
      ? settings?.max_standby_archive_delay
      : envOverride(
          "SUPABASE_DB_SETTINGS_MAX_STANDBY_ARCHIVE_DELAY",
          settings?.max_standby_archive_delay,
          projectEnvValues,
        ),
    max_standby_streaming_delay: remoteWins("db.settings.max_standby_streaming_delay")
      ? settings?.max_standby_streaming_delay
      : envOverride(
          "SUPABASE_DB_SETTINGS_MAX_STANDBY_STREAMING_DELAY",
          settings?.max_standby_streaming_delay,
          projectEnvValues,
        ),
    max_wal_size: remoteWins("db.settings.max_wal_size")
      ? settings?.max_wal_size
      : envOverride("SUPABASE_DB_SETTINGS_MAX_WAL_SIZE", settings?.max_wal_size, projectEnvValues),
    max_wal_senders: remoteWins("db.settings.max_wal_senders")
      ? settings?.max_wal_senders
      : envOverrideOptionalUint(
          "SUPABASE_DB_SETTINGS_MAX_WAL_SENDERS",
          "db.settings.max_wal_senders",
          settings?.max_wal_senders,
          projectEnvValues,
        ),
    max_worker_processes: remoteWins("db.settings.max_worker_processes")
      ? settings?.max_worker_processes
      : envOverrideOptionalUint(
          "SUPABASE_DB_SETTINGS_MAX_WORKER_PROCESSES",
          "db.settings.max_worker_processes",
          settings?.max_worker_processes,
          projectEnvValues,
        ),
    session_replication_role: remoteWins("db.settings.session_replication_role")
      ? settings?.session_replication_role
      : envOverrideSessionReplicationRole(settings?.session_replication_role, projectEnvValues),
    shared_buffers: remoteWins("db.settings.shared_buffers")
      ? settings?.shared_buffers
      : envOverride(
          "SUPABASE_DB_SETTINGS_SHARED_BUFFERS",
          settings?.shared_buffers,
          projectEnvValues,
        ),
    statement_timeout: remoteWins("db.settings.statement_timeout")
      ? settings?.statement_timeout
      : envOverride(
          "SUPABASE_DB_SETTINGS_STATEMENT_TIMEOUT",
          settings?.statement_timeout,
          projectEnvValues,
        ),
    track_activity_query_size: remoteWins("db.settings.track_activity_query_size")
      ? settings?.track_activity_query_size
      : envOverride(
          "SUPABASE_DB_SETTINGS_TRACK_ACTIVITY_QUERY_SIZE",
          settings?.track_activity_query_size,
          projectEnvValues,
        ),
    track_commit_timestamp: remoteWins("db.settings.track_commit_timestamp")
      ? settings?.track_commit_timestamp
      : envOverrideOptionalBool(
          "SUPABASE_DB_SETTINGS_TRACK_COMMIT_TIMESTAMP",
          settings?.track_commit_timestamp,
          "db.settings.track_commit_timestamp",
          projectEnvValues,
        ),
    wal_keep_size: remoteWins("db.settings.wal_keep_size")
      ? settings?.wal_keep_size
      : envOverride(
          "SUPABASE_DB_SETTINGS_WAL_KEEP_SIZE",
          settings?.wal_keep_size,
          projectEnvValues,
        ),
    wal_sender_timeout: remoteWins("db.settings.wal_sender_timeout")
      ? settings?.wal_sender_timeout
      : envOverride(
          "SUPABASE_DB_SETTINGS_WAL_SENDER_TIMEOUT",
          settings?.wal_sender_timeout,
          projectEnvValues,
        ),
    work_mem: remoteWins("db.settings.work_mem")
      ? settings?.work_mem
      : envOverride("SUPABASE_DB_SETTINGS_WORK_MEM", settings?.work_mem, projectEnvValues),
  };
}

/** `password_requirements` fixed enum (`@supabase/config`'s `packages/config/src/auth/index.ts`). */
const PASSWORD_REQUIREMENTS_VALUES = new Set([
  "",
  "letters_digits",
  "lower_upper_letters_digits",
  "lower_upper_letters_digits_symbols",
]);

/**
 * Enum-flavored sibling of {@link envOverride} for `auth.password_requirements`. Exported so
 * `db start`'s own eager-validation battery can call it directly instead of duplicating the
 * check.
 */
export function envOverrideAuthPasswordRequirements(
  configured: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): string {
  const override = envOverride("SUPABASE_AUTH_PASSWORD_REQUIREMENTS", undefined, projectEnvValues);
  if (override !== undefined && !PASSWORD_REQUIREMENTS_VALUES.has(override)) {
    throw new Error(`Failed reading config: Invalid auth.password_requirements: ${override}.`);
  }
  return override ?? configured;
}

/** Narrows an unknown value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Resolves `auth.external_url`, not modeled in `@supabase/config`'s schema, from the raw
 * document. Shared by `supabase start`'s long-running GoTrue container and `db start`'s
 * one-shot auth migration job so both resolve the same value. `remoteOverrideKeys` lets a
 * matched remote block win over a conflicting `SUPABASE_AUTH_EXTERNAL_URL`.
 */
export function resolveAuthExternalUrl(
  document: Readonly<Record<string, unknown>> | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
  remoteOverrideKeys: ReadonlySet<string> = new Set(),
): string | undefined {
  const remoteWins = makeRemoteWins(remoteOverrideKeys);
  const rawAuthExternalUrl = asRecord(document?.["auth"])?.["external_url"];
  const configuredAuthExternalUrl =
    typeof rawAuthExternalUrl === "string" ? rawAuthExternalUrl : undefined;
  if (remoteWins("auth.external_url")) return configuredAuthExternalUrl;
  return envOverride("SUPABASE_AUTH_EXTERNAL_URL", configuredAuthExternalUrl, projectEnvValues);
}

/** Hook-type iteration order for {@link resolveAuthHooks}'s output. */
const HOOK_TYPE_ORDER = [
  "mfa_verification_attempt",
  "password_verification_attempt",
  "custom_access_token",
  "send_sms",
  "send_email",
  "before_user_created",
] as const;

/** camelCase key {@link resolveAuthHooks} exposes per {@link HOOK_TYPE_ORDER} entry, matching `gotrue.service.ts`'s env-input field names. */
const HOOK_TYPE_TO_CAMEL = {
  mfa_verification_attempt: "mfaVerificationAttempt",
  password_verification_attempt: "passwordVerificationAttempt",
  custom_access_token: "customAccessToken",
  send_sms: "sendSms",
  send_email: "sendEmail",
  before_user_created: "beforeUserCreated",
} as const satisfies Record<(typeof HOOK_TYPE_ORDER)[number], string>;

interface ResolvedAuthHook {
  readonly enabled: boolean;
  readonly uri: string;
  readonly secrets: string;
}

export type ResolvedAuthHooks = {
  readonly [K in (typeof HOOK_TYPE_TO_CAMEL)[keyof typeof HOOK_TYPE_TO_CAMEL]]: ResolvedAuthHook;
};

/**
 * Resolves `auth.hook.<type>.*` overrides in {@link HOOK_TYPE_ORDER}. Each type's presence in
 * the raw `authDocument` gates whether an env override applies, since the schema always
 * decodes a `{ enabled: false }` default regardless of file presence. Hoisted so both
 * `resolveLocalConfigValues` and `start.handler.ts`'s GoTrue env resolution share this same
 * result.
 */
export function resolveAuthHooks(
  authDocument: Readonly<Record<string, unknown>> | undefined,
  hook: CliConfig["auth"]["hook"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
  /**
   * Fields whose overrides below can throw or otherwise cause a downstream rejection on a
   * malformed value belong in this set so a matched remote block's value wins instead. A
   * matched remote flattens the whole `auth.hook.<type>` block, so every leaf
   * (`enabled`/`uri`/`secrets`) is included, not just `enabled`.
   */
  remoteOverrideKeys: ReadonlySet<string> = new Set(),
): ResolvedAuthHooks {
  const remoteWins = makeRemoteWins(remoteOverrideKeys);
  const hookDocument = asRecord(authDocument?.["hook"]);
  const result = {} as Record<string, ResolvedAuthHook>;
  for (const hookType of HOOK_TYPE_ORDER) {
    const h = hook[hookType];
    const hookSectionPresent = asRecord(hookDocument?.[hookType]) !== undefined;
    const envPrefix = `SUPABASE_AUTH_HOOK_${hookType.toUpperCase()}`;
    const enabled = remoteWins(`auth.hook.${hookType}.enabled`)
      ? h.enabled
      : hookSectionPresent
        ? envOverrideBool(
            `${envPrefix}_ENABLED`,
            h.enabled,
            `auth.hook.${hookType}.enabled`,
            projectEnvValues,
          )
        : h.enabled;
    const uri =
      (remoteWins(`auth.hook.${hookType}.uri`)
        ? h.uri
        : hookSectionPresent
          ? envOverride(`${envPrefix}_URI`, h.uri, projectEnvValues)
          : h.uri) ?? "";
    const secrets =
      (remoteWins(`auth.hook.${hookType}.secrets`)
        ? h.secrets
        : hookSectionPresent
          ? envOverride(`${envPrefix}_SECRETS`, h.secrets, projectEnvValues)
          : h.secrets) ?? "";
    result[HOOK_TYPE_TO_CAMEL[hookType]] = { enabled, uri, secrets };
  }
  return result as ResolvedAuthHooks;
}

/**
 * Resolves `auth.mfa`'s per-factor fields. Unlike hooks/smtp, `auth.mfa.<factor>` is always
 * bound (no schema presence gap), so overrides always apply. Hoisted so both
 * `resolveLocalConfigValues` and `start.handler.ts`'s GoTrue env resolution share this same
 * result.
 */
export function resolveAuthMfa(
  mfa: CliConfig["auth"]["mfa"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
  /**
   * Fields whose `envOverrideBool`/`envOverrideUint`/`envOverride` calls below can throw or
   * otherwise cause a downstream rejection on a malformed value belong in this set so a
   * matched remote block's value wins instead of aborting on an unrelated bad env var.
   */
  remoteOverrideKeys: ReadonlySet<string> = new Set(),
): CliConfig["auth"]["mfa"] {
  const remoteWins = makeRemoteWins(remoteOverrideKeys);
  return {
    totp: {
      enroll_enabled: remoteWins("auth.mfa.totp.enroll_enabled")
        ? mfa.totp.enroll_enabled
        : envOverrideBool(
            "SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED",
            mfa.totp.enroll_enabled,
            "auth.mfa.totp.enroll_enabled",
            projectEnvValues,
          ),
      verify_enabled: remoteWins("auth.mfa.totp.verify_enabled")
        ? mfa.totp.verify_enabled
        : envOverrideBool(
            "SUPABASE_AUTH_MFA_TOTP_VERIFY_ENABLED",
            mfa.totp.verify_enabled,
            "auth.mfa.totp.verify_enabled",
            projectEnvValues,
          ),
    },
    phone: {
      enroll_enabled: remoteWins("auth.mfa.phone.enroll_enabled")
        ? mfa.phone.enroll_enabled
        : envOverrideBool(
            "SUPABASE_AUTH_MFA_PHONE_ENROLL_ENABLED",
            mfa.phone.enroll_enabled,
            "auth.mfa.phone.enroll_enabled",
            projectEnvValues,
          ),
      verify_enabled: remoteWins("auth.mfa.phone.verify_enabled")
        ? mfa.phone.verify_enabled
        : envOverrideBool(
            "SUPABASE_AUTH_MFA_PHONE_VERIFY_ENABLED",
            mfa.phone.verify_enabled,
            "auth.mfa.phone.verify_enabled",
            projectEnvValues,
          ),
      otp_length: remoteWins("auth.mfa.phone.otp_length")
        ? mfa.phone.otp_length
        : envOverrideUint(
            "SUPABASE_AUTH_MFA_PHONE_OTP_LENGTH",
            "auth.mfa.phone.otp_length",
            mfa.phone.otp_length,
            projectEnvValues,
          ),
      template: remoteWins("auth.mfa.phone.template")
        ? mfa.phone.template
        : (envOverride("SUPABASE_AUTH_MFA_PHONE_TEMPLATE", mfa.phone.template, projectEnvValues) ??
          mfa.phone.template),
      max_frequency: remoteWins("auth.mfa.phone.max_frequency")
        ? mfa.phone.max_frequency
        : (envOverride(
            "SUPABASE_AUTH_MFA_PHONE_MAX_FREQUENCY",
            mfa.phone.max_frequency,
            projectEnvValues,
          ) ?? mfa.phone.max_frequency),
    },
    web_authn: {
      enroll_enabled: remoteWins("auth.mfa.web_authn.enroll_enabled")
        ? mfa.web_authn.enroll_enabled
        : envOverrideBool(
            "SUPABASE_AUTH_MFA_WEB_AUTHN_ENROLL_ENABLED",
            mfa.web_authn.enroll_enabled,
            "auth.mfa.web_authn.enroll_enabled",
            projectEnvValues,
          ),
      verify_enabled: remoteWins("auth.mfa.web_authn.verify_enabled")
        ? mfa.web_authn.verify_enabled
        : envOverrideBool(
            "SUPABASE_AUTH_MFA_WEB_AUTHN_VERIFY_ENABLED",
            mfa.web_authn.verify_enabled,
            "auth.mfa.web_authn.verify_enabled",
            projectEnvValues,
          ),
    },
    max_enrolled_factors: remoteWins("auth.mfa.max_enrolled_factors")
      ? mfa.max_enrolled_factors
      : envOverrideUint(
          "SUPABASE_AUTH_MFA_MAX_ENROLLED_FACTORS",
          "auth.mfa.max_enrolled_factors",
          mfa.max_enrolled_factors,
          projectEnvValues,
        ),
  };
}

/**
 * Resolves `auth.rate_limit.*`, all plain `uint`s with no presence gate: every
 * `SUPABASE_AUTH_RATE_LIMIT_*` override applies unconditionally.
 */
export function resolveGotrueRateLimit(
  rateLimit: CliConfig["auth"]["rate_limit"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): CliConfig["auth"]["rate_limit"] {
  return {
    anonymous_users: envOverrideUint(
      "SUPABASE_AUTH_RATE_LIMIT_ANONYMOUS_USERS",
      "auth.rate_limit.anonymous_users",
      rateLimit.anonymous_users,
      projectEnvValues,
    ),
    token_refresh: envOverrideUint(
      "SUPABASE_AUTH_RATE_LIMIT_TOKEN_REFRESH",
      "auth.rate_limit.token_refresh",
      rateLimit.token_refresh,
      projectEnvValues,
    ),
    sign_in_sign_ups: envOverrideUint(
      "SUPABASE_AUTH_RATE_LIMIT_SIGN_IN_SIGN_UPS",
      "auth.rate_limit.sign_in_sign_ups",
      rateLimit.sign_in_sign_ups,
      projectEnvValues,
    ),
    token_verifications: envOverrideUint(
      "SUPABASE_AUTH_RATE_LIMIT_TOKEN_VERIFICATIONS",
      "auth.rate_limit.token_verifications",
      rateLimit.token_verifications,
      projectEnvValues,
    ),
    email_sent: envOverrideUint(
      "SUPABASE_AUTH_RATE_LIMIT_EMAIL_SENT",
      "auth.rate_limit.email_sent",
      rateLimit.email_sent,
      projectEnvValues,
    ),
    sms_sent: envOverrideUint(
      "SUPABASE_AUTH_RATE_LIMIT_SMS_SENT",
      "auth.rate_limit.sms_sent",
      rateLimit.sms_sent,
      projectEnvValues,
    ),
    web3: envOverrideUint(
      "SUPABASE_AUTH_RATE_LIMIT_WEB3",
      "auth.rate_limit.web3",
      rateLimit.web3,
      projectEnvValues,
    ),
  };
}

/**
 * Resolves `auth.sessions.{timebox,inactivity_timeout}`. An env override can introduce a
 * value even when `[auth.sessions]` was never in config.toml, since `config.auth.sessions`
 * can be `undefined` here unlike other always-bound sections.
 */
export function resolveGotrueSessions(
  sessions: CliConfig["auth"]["sessions"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): CliConfig["auth"]["sessions"] {
  const timebox = envOverride(
    "SUPABASE_AUTH_SESSIONS_TIMEBOX",
    sessions?.timebox,
    projectEnvValues,
  );
  const inactivityTimeout = envOverride(
    "SUPABASE_AUTH_SESSIONS_INACTIVITY_TIMEOUT",
    sessions?.inactivity_timeout,
    projectEnvValues,
  );
  if (timebox === undefined && inactivityTimeout === undefined) return sessions;
  return { timebox, inactivity_timeout: inactivityTimeout };
}

/**
 * Resolves `auth.passkey`/`auth.webauthn`, which have no `@supabase/config` schema fields at
 * all: presence and every field come from the raw TOML document. An absent section is never
 * synthesized from an env override alone.
 */
export function resolveGotruePasskeyWebauthn(
  document: Readonly<Record<string, unknown>> | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): {
  readonly passkeyEnabled: boolean | undefined;
  readonly webauthn:
    | {
        readonly rpId: string;
        readonly rpDisplayName: string;
        readonly rpOrigins: ReadonlyArray<string>;
      }
    | undefined;
} {
  const authDoc = asRecord(document?.["auth"]);
  const passkeyDoc = asRecord(authDoc?.["passkey"]);
  const webauthnDoc = asRecord(authDoc?.["webauthn"]);
  const passkeyEnabled =
    passkeyDoc !== undefined
      ? envOverrideBool(
          "SUPABASE_AUTH_PASSKEY_ENABLED",
          rawUnmodeledBool(passkeyDoc["enabled"], "auth.passkey.enabled"),
          "auth.passkey.enabled",
          projectEnvValues,
        )
      : undefined;
  const rpOriginsOverride =
    webauthnDoc !== undefined
      ? envOverride("SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS", undefined, projectEnvValues)
      : undefined;
  const webauthn =
    webauthnDoc !== undefined
      ? {
          rpId:
            envOverride(
              "SUPABASE_AUTH_WEBAUTHN_RP_ID",
              typeof webauthnDoc["rp_id"] === "string" ? webauthnDoc["rp_id"] : "",
              projectEnvValues,
            ) ?? "",
          rpDisplayName:
            envOverride(
              "SUPABASE_AUTH_WEBAUTHN_RP_DISPLAY_NAME",
              typeof webauthnDoc["rp_display_name"] === "string"
                ? webauthnDoc["rp_display_name"]
                : "",
              projectEnvValues,
            ) ?? "",
          // A raw or `env(...)`-resolved `rp_origins` string is comma-split, not dropped.
          rpOrigins: (() => {
            if (rpOriginsOverride !== undefined) return strToArr(rpOriginsOverride);
            const raw = webauthnDoc["rp_origins"];
            if (Array.isArray(raw)) {
              return raw.filter((item): item is string => typeof item === "string");
            }
            return typeof raw === "string" ? strToArr(raw) : [];
          })(),
        }
      : undefined;
  return { passkeyEnabled, webauthn };
}

/** Resolves `auth.web3.*.enabled`, both value-typed with no presence gate — overrides always apply. */
export function resolveGotrueWeb3(
  web3: CliConfig["auth"]["web3"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): CliConfig["auth"]["web3"] {
  return {
    solana: {
      enabled: envOverrideBool(
        "SUPABASE_AUTH_WEB3_SOLANA_ENABLED",
        web3.solana.enabled,
        "auth.web3.solana.enabled",
        projectEnvValues,
      ),
    },
    ethereum: {
      enabled: envOverrideBool(
        "SUPABASE_AUTH_WEB3_ETHEREUM_ENABLED",
        web3.ethereum.enabled,
        "auth.web3.ethereum.enabled",
        projectEnvValues,
      ),
    },
  };
}

/** Resolves `auth.oauth_server.*`, value-typed with no presence gate — overrides always apply. */
export function resolveGotrueOAuthServer(
  oauthServer: CliConfig["auth"]["oauth_server"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): CliConfig["auth"]["oauth_server"] {
  return {
    enabled: envOverrideBool(
      "SUPABASE_AUTH_OAUTH_SERVER_ENABLED",
      oauthServer.enabled,
      "auth.oauth_server.enabled",
      projectEnvValues,
    ),
    authorization_url_path:
      envOverride(
        "SUPABASE_AUTH_OAUTH_SERVER_AUTHORIZATION_URL_PATH",
        oauthServer.authorization_url_path,
        projectEnvValues,
      ) ?? oauthServer.authorization_url_path,
    allow_dynamic_registration: envOverrideBool(
      "SUPABASE_AUTH_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION",
      oauthServer.allow_dynamic_registration,
      "auth.oauth_server.allow_dynamic_registration",
      projectEnvValues,
    ),
  };
}

/**
 * Resolves enabled `auth.third_party.<provider>` entries in a fixed order, forwarding only
 * the enabled ones. `remoteOverrideKeys` lets a matched remote block's value win over a
 * conflicting `SUPABASE_AUTH_THIRD_PARTY_*_ENABLED`, since `envOverrideBool` would otherwise
 * throw and abort the whole call.
 */
export function resolveThirdPartyProviders(
  thirdParty: CliConfig["auth"]["third_party"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
  remoteOverrideKeys: ReadonlySet<string> = new Set(),
): ReadonlyArray<ThirdPartyInput> {
  const remoteWins = makeRemoteWins(remoteOverrideKeys);
  const resolved: Array<ThirdPartyInput> = [];
  if (
    remoteWins("auth.third_party.firebase.enabled")
      ? thirdParty.firebase.enabled
      : envOverrideBool(
          "SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED",
          thirdParty.firebase.enabled,
          "auth.third_party.firebase.enabled",
          projectEnvValues,
        )
  ) {
    resolved.push({
      provider: "firebase",
      requiredField:
        (remoteWins("auth.third_party.firebase.project_id")
          ? thirdParty.firebase.project_id
          : envOverride(
              "SUPABASE_AUTH_THIRD_PARTY_FIREBASE_PROJECT_ID",
              thirdParty.firebase.project_id,
              projectEnvValues,
            )) ?? "",
    });
  }
  if (
    remoteWins("auth.third_party.auth0.enabled")
      ? thirdParty.auth0.enabled
      : envOverrideBool(
          "SUPABASE_AUTH_THIRD_PARTY_AUTH0_ENABLED",
          thirdParty.auth0.enabled,
          "auth.third_party.auth0.enabled",
          projectEnvValues,
        )
  ) {
    resolved.push({
      provider: "auth0",
      requiredField:
        (remoteWins("auth.third_party.auth0.tenant")
          ? thirdParty.auth0.tenant
          : envOverride(
              "SUPABASE_AUTH_THIRD_PARTY_AUTH0_TENANT",
              thirdParty.auth0.tenant,
              projectEnvValues,
            )) ?? "",
    });
  }
  if (
    remoteWins("auth.third_party.aws_cognito.enabled")
      ? thirdParty.aws_cognito.enabled
      : envOverrideBool(
          "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_ENABLED",
          thirdParty.aws_cognito.enabled,
          "auth.third_party.aws_cognito.enabled",
          projectEnvValues,
        )
  ) {
    resolved.push({
      provider: "cognito",
      requiredField:
        (remoteWins("auth.third_party.aws_cognito.user_pool_id")
          ? thirdParty.aws_cognito.user_pool_id
          : envOverride(
              "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_USER_POOL_ID",
              thirdParty.aws_cognito.user_pool_id,
              projectEnvValues,
            )) ?? "",
      cognitoUserPoolRegion: remoteWins("auth.third_party.aws_cognito.user_pool_region")
        ? thirdParty.aws_cognito.user_pool_region
        : envOverride(
            "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_USER_POOL_REGION",
            thirdParty.aws_cognito.user_pool_region,
            projectEnvValues,
          ),
    });
  }
  if (
    remoteWins("auth.third_party.clerk.enabled")
      ? thirdParty.clerk.enabled
      : envOverrideBool(
          "SUPABASE_AUTH_THIRD_PARTY_CLERK_ENABLED",
          thirdParty.clerk.enabled,
          "auth.third_party.clerk.enabled",
          projectEnvValues,
        )
  ) {
    resolved.push({
      provider: "clerk",
      requiredField:
        (remoteWins("auth.third_party.clerk.domain")
          ? thirdParty.clerk.domain
          : envOverride(
              "SUPABASE_AUTH_THIRD_PARTY_CLERK_DOMAIN",
              thirdParty.clerk.domain,
              projectEnvValues,
            )) ?? "",
    });
  }
  if (
    remoteWins("auth.third_party.workos.enabled")
      ? thirdParty.workos.enabled
      : envOverrideBool(
          "SUPABASE_AUTH_THIRD_PARTY_WORKOS_ENABLED",
          thirdParty.workos.enabled,
          "auth.third_party.workos.enabled",
          projectEnvValues,
        )
  ) {
    resolved.push({
      provider: "workos",
      requiredField:
        (remoteWins("auth.third_party.workos.issuer_url")
          ? thirdParty.workos.issuer_url
          : envOverride(
              "SUPABASE_AUTH_THIRD_PARTY_WORKOS_ISSUER_URL",
              thirdParty.workos.issuer_url,
              projectEnvValues,
            )) ?? "",
    });
  }
  return resolved;
}

/** Fixed SMS provider priority — validation stops at the first enabled provider. */
const SMS_PROVIDER_ORDER = [
  "twilio",
  "twilio_verify",
  "messagebird",
  "textlocal",
  "vonage",
] as const;

/**
 * Resolves `auth.sms`'s full field set so `SUPABASE_AUTH_SMS_*` overrides reach GoTrue's env,
 * not just validation. Presence-gated per provider except `twilio`, whose default template
 * always includes an uncommented `[auth.sms.twilio]` table; the 4 top-level scalars have no
 * gate for the same reason. `test_otp` (a map) is left unresolved: it has no env var.
 */
export function resolveAuthSms(
  authDocument: Readonly<Record<string, unknown>> | undefined,
  sms: CliConfig["auth"]["sms"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
  /**
   * Fields whose `envOverrideBool`/`decryptAuthSecret` calls below can throw on a malformed
   * value belong in this set so a matched remote block's value wins instead of aborting on an
   * unrelated bad env var. Reachable from the `db diff --linked`/`db pull` shadow path via
   * `validateAuthSmsProviders`, not just this function's direct callers.
   */
  remoteOverrideKeys: ReadonlySet<string> = new Set(),
): CliConfig["auth"]["sms"] {
  const smsDoc = asRecord(authDocument?.["sms"]);
  const remoteWins = makeRemoteWins(remoteOverrideKeys);

  function providerPresent(providerName: (typeof SMS_PROVIDER_ORDER)[number]): boolean {
    // `twilio` is always considered present — see this function's doc comment.
    if (providerName === "twilio") return true;
    return smsDoc !== undefined && asRecord(smsDoc[providerName]) !== undefined;
  }

  function resolveEnabled(
    providerName: (typeof SMS_PROVIDER_ORDER)[number],
    configured: boolean,
  ): boolean {
    if (remoteWins(`auth.sms.${providerName}.enabled`)) return configured;
    if (!providerPresent(providerName)) return configured;
    return envOverrideBool(
      `SUPABASE_AUTH_SMS_${providerName.toUpperCase()}_ENABLED`,
      configured,
      `auth.sms.${providerName}.enabled`,
      projectEnvValues,
    );
  }

  // `remoteOverrideKey` is explicit (not reconstructed from `providerName`/`field`) since
  // `field`'s shape differs per provider, and not every combination is a real config key.
  function resolveField(
    providerName: (typeof SMS_PROVIDER_ORDER)[number],
    field: string,
    remoteOverrideKey: RemoteOverridableKey,
    configured: string | undefined,
  ): string | undefined {
    if (remoteWins(remoteOverrideKey)) return configured;
    if (!providerPresent(providerName)) return configured;
    return envOverride(
      `SUPABASE_AUTH_SMS_${providerName.toUpperCase()}_${field.toUpperCase()}`,
      configured,
      projectEnvValues,
    );
  }

  /** Resolves a provider's Secret-typed field, gated the same way `auth.email.smtp.pass` is. */
  function resolveSecretField(
    providerName: (typeof SMS_PROVIDER_ORDER)[number],
    field: string,
    remoteOverrideKey: RemoteOverridableKey,
    configured: string | undefined,
  ): string | undefined {
    return remoteWins(remoteOverrideKey)
      ? decryptAuthSecret(configured, projectEnvValues)
      : decryptAuthSecret(
          resolveField(providerName, field, remoteOverrideKey, configured),
          projectEnvValues,
        );
  }

  const twilioEnabled = resolveEnabled("twilio", sms.twilio.enabled);
  const twilioVerifyEnabled = resolveEnabled("twilio_verify", sms.twilio_verify.enabled);
  const messagebirdEnabled = resolveEnabled("messagebird", sms.messagebird.enabled);
  const textlocalEnabled = resolveEnabled("textlocal", sms.textlocal.enabled);
  const vonageEnabled = resolveEnabled("vonage", sms.vonage.enabled);
  const anyProviderEnabled =
    twilioEnabled || twilioVerifyEnabled || messagebirdEnabled || textlocalEnabled || vonageEnabled;
  const enableSignupConfigured = remoteWins("auth.sms.enable_signup")
    ? sms.enable_signup
    : envOverrideBool(
        "SUPABASE_AUTH_SMS_ENABLE_SIGNUP",
        sms.enable_signup,
        "auth.sms.enable_signup",
        projectEnvValues,
      );

  return {
    ...sms,
    // Phone signup is never enabled when no provider is configured to deliver an OTP.
    enable_signup: anyProviderEnabled ? enableSignupConfigured : false,
    enable_confirmations: remoteWins("auth.sms.enable_confirmations")
      ? sms.enable_confirmations
      : envOverrideBool(
          "SUPABASE_AUTH_SMS_ENABLE_CONFIRMATIONS",
          sms.enable_confirmations,
          "auth.sms.enable_confirmations",
          projectEnvValues,
        ),
    template: remoteWins("auth.sms.template")
      ? sms.template
      : (envOverride("SUPABASE_AUTH_SMS_TEMPLATE", sms.template, projectEnvValues) ?? sms.template),
    max_frequency: remoteWins("auth.sms.max_frequency")
      ? sms.max_frequency
      : (envOverride("SUPABASE_AUTH_SMS_MAX_FREQUENCY", sms.max_frequency, projectEnvValues) ??
        sms.max_frequency),
    twilio: {
      enabled: twilioEnabled,
      account_sid:
        resolveField(
          "twilio",
          "account_sid",
          "auth.sms.twilio.account_sid",
          sms.twilio.account_sid,
        ) ?? "",
      message_service_sid:
        resolveField(
          "twilio",
          "message_service_sid",
          "auth.sms.twilio.message_service_sid",
          sms.twilio.message_service_sid,
        ) ?? "",
      auth_token: resolveSecretField(
        "twilio",
        "auth_token",
        "auth.sms.twilio.auth_token",
        sms.twilio.auth_token,
      ),
    },
    twilio_verify: {
      enabled: twilioVerifyEnabled,
      account_sid: resolveField(
        "twilio_verify",
        "account_sid",
        "auth.sms.twilio_verify.account_sid",
        sms.twilio_verify.account_sid,
      ),
      message_service_sid: resolveField(
        "twilio_verify",
        "message_service_sid",
        "auth.sms.twilio_verify.message_service_sid",
        sms.twilio_verify.message_service_sid,
      ),
      auth_token: resolveSecretField(
        "twilio_verify",
        "auth_token",
        "auth.sms.twilio_verify.auth_token",
        sms.twilio_verify.auth_token,
      ),
    },
    messagebird: {
      enabled: messagebirdEnabled,
      originator: resolveField(
        "messagebird",
        "originator",
        "auth.sms.messagebird.originator",
        sms.messagebird.originator,
      ),
      access_key: resolveSecretField(
        "messagebird",
        "access_key",
        "auth.sms.messagebird.access_key",
        sms.messagebird.access_key,
      ),
    },
    textlocal: {
      enabled: textlocalEnabled,
      sender: resolveField(
        "textlocal",
        "sender",
        "auth.sms.textlocal.sender",
        sms.textlocal.sender,
      ),
      api_key: resolveSecretField(
        "textlocal",
        "api_key",
        "auth.sms.textlocal.api_key",
        sms.textlocal.api_key,
      ),
    },
    vonage: {
      enabled: vonageEnabled,
      from: resolveField("vonage", "from", "auth.sms.vonage.from", sms.vonage.from),
      api_key: resolveField("vonage", "api_key", "auth.sms.vonage.api_key", sms.vonage.api_key),
      api_secret: resolveSecretField(
        "vonage",
        "api_secret",
        "auth.sms.vonage.api_secret",
        sms.vonage.api_secret,
      ),
    },
  };
}

/**
 * Validates only the first enabled provider in {@link SMS_PROVIDER_ORDER}; a later
 * enabled-but-incomplete provider is never checked. Runs against {@link resolveAuthSms}'s
 * env-override-aware result.
 */
function validateAuthSmsProviders(
  authDocument: Record<string, unknown> | undefined,
  sms: CliConfig["auth"]["sms"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
  remoteOverrideKeys: ReadonlySet<string> = new Set(),
): void {
  const resolved = resolveAuthSms(authDocument, sms, projectEnvValues, remoteOverrideKeys);

  function requireField(provider: string, field: string, value: string | undefined): void {
    if (value === undefined || value.length === 0) {
      throw new ConfigValidateError(
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

/** Deleted external providers, warned on if still enabled, never validated. */
const DEPRECATED_EXTERNAL_PROVIDERS = new Set(["linkedin", "slack"]);

/** Matches `GotrueExternalProviderInput`'s fields, kept separate to avoid a command-specific import. */
export interface ResolvedAuthExternalProvider {
  readonly enabled: boolean;
  readonly clientId: string;
  readonly secret?: string;
  readonly url: string;
  readonly redirectUri?: string;
  readonly skipNonceCheck: boolean;
  readonly emailOptional: boolean;
}

/**
 * Weakly coerces an unmodeled raw-document value (no `@supabase/config` schema, e.g. custom
 * `auth.external` providers, `auth.passkey`/`auth.webauthn`) to a bool, since an `env(VAR)`
 * substitution there skips normal type coercion and leaves a literal `"true"`/`"false"`
 * string. A number coerces via truthiness (`!= 0`); an unparsable string or any other type
 * throws rather than silently defaulting to `false`.
 */
export function rawUnmodeledBool(value: unknown, dottedFieldPath: string): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const parsed = parseGoBool(value);
    if (parsed === undefined) {
      throw new InvalidBoolEnvOverrideError(dottedFieldPath, value);
    }
    return parsed;
  }
  throw new InvalidBoolEnvOverrideError(dottedFieldPath, String(value));
}

/**
 * Comma-splits a string into an array (empty string → `[]`), the same rule config decode
 * applies to a raw or `env(VAR)`-resolved value destined for an unmodeled `[]string` field
 * (e.g. `auth.webauthn.rp_origins`).
 */
export function strToArr(value: string): Array<string> {
  return value.length === 0 ? [] : value.split(",");
}

/**
 * Resolves `auth.external.<name>` overrides, iterating the raw document's provider names
 * (not just the schema's fixed ~19) since custom providers decode with no schema at all.
 * `apple` is always included, since the default config.toml template registers it
 * uncommented. Hoisted so both {@link validateAuthExternalProviders} and `start.handler.ts`'s
 * GoTrue env resolution share this same result.
 */
export function resolveAuthExternalProviders(
  authDocument: Readonly<Record<string, unknown>> | undefined,
  external: CliConfig["auth"]["external"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
  /**
   * Fields whose `envOverrideBool`/`decryptAuthSecret` calls below can throw on a malformed
   * value belong in this set so a matched remote block's value wins instead of aborting on an
   * unrelated bad env var. Provider names are dynamic, so these keys are tracked via
   * `applyRemoteOverride` rather than a fixed `ENV_OVERRIDABLE_KEYS` entry.
   */
  remoteOverrideKeys: ReadonlySet<string> = new Set(),
): Record<string, ResolvedAuthExternalProvider> {
  const remoteWins = makeRemoteWins(remoteOverrideKeys);
  const externalDoc = asRecord(authDocument?.["external"]);

  const result: Record<string, ResolvedAuthExternalProvider> = {};
  const decodedProviders = new Map(Object.entries(external));
  // Iterates the raw document's keys (not `Object.entries(external)`) to catch custom
  // provider names; `apple` is unioned in since the default template always registers it.
  const providerNames = new Set([...Object.keys(externalDoc ?? {}), "apple"]);
  for (const name of providerNames) {
    if (DEPRECATED_EXTERNAL_PROVIDERS.has(name)) continue;
    const envPrefix = `SUPABASE_AUTH_EXTERNAL_${name.toUpperCase()}`;
    const provider = decodedProviders.get(name);
    const rawProvider = provider === undefined ? asRecord(externalDoc?.[name]) : undefined;
    if (provider === undefined && rawProvider === undefined) continue;
    const configuredEnabled =
      provider?.enabled ??
      rawUnmodeledBool(rawProvider?.["enabled"], `auth.external.${name}.enabled`);
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
      rawUnmodeledBool(rawProvider?.["skip_nonce_check"], `auth.external.${name}.skip_nonce_check`);
    const configuredEmailOptional =
      provider?.email_optional ??
      rawUnmodeledBool(rawProvider?.["email_optional"], `auth.external.${name}.email_optional`);

    result[name] = {
      enabled: remoteWins(`auth.external.${name}.enabled`)
        ? configuredEnabled
        : envOverrideBool(
            `${envPrefix}_ENABLED`,
            configuredEnabled,
            `auth.external.${name}.enabled`,
            projectEnvValues,
          ),
      clientId:
        (remoteWins(`auth.external.${name}.client_id`)
          ? configuredClientId
          : envOverride(`${envPrefix}_CLIENT_ID`, configuredClientId, projectEnvValues)) ?? "",
      secret: remoteWins(`auth.external.${name}.secret`)
        ? decryptAuthSecret(configuredSecret, projectEnvValues)
        : decryptAuthSecret(
            envOverride(`${envPrefix}_SECRET`, configuredSecret, projectEnvValues),
            projectEnvValues,
          ),
      url:
        (remoteWins(`auth.external.${name}.url`)
          ? configuredUrl
          : envOverride(`${envPrefix}_URL`, configuredUrl, projectEnvValues)) ?? "",
      redirectUri: remoteWins(`auth.external.${name}.redirect_uri`)
        ? configuredRedirectUri
        : envOverride(`${envPrefix}_REDIRECT_URI`, configuredRedirectUri, projectEnvValues),
      skipNonceCheck: remoteWins(`auth.external.${name}.skip_nonce_check`)
        ? configuredSkipNonceCheck
        : envOverrideBool(
            `${envPrefix}_SKIP_NONCE_CHECK`,
            configuredSkipNonceCheck,
            `auth.external.${name}.skip_nonce_check`,
            projectEnvValues,
          ),
      emailOptional: remoteWins(`auth.external.${name}.email_optional`)
        ? configuredEmailOptional
        : envOverrideBool(
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
 * Validates required fields for every enabled `auth.external.<name>` provider, including
 * custom names `@supabase/config`'s schema silently drops at decode time. Runs against
 * {@link resolveAuthExternalProviders}'s env-override-aware result, since the schema's own
 * `requiredWhenEnabled` check only sees the pre-override, known-providers-only value.
 */
function validateAuthExternalProviders(
  authDocument: Record<string, unknown> | undefined,
  external: CliConfig["auth"]["external"],
  projectEnvValues: Readonly<Record<string, string>> | undefined,
  remoteOverrideKeys: ReadonlySet<string> = new Set(),
): void {
  const resolved = resolveAuthExternalProviders(
    authDocument,
    external,
    projectEnvValues,
    remoteOverrideKeys,
  );
  for (const [name, provider] of Object.entries(resolved)) {
    if (!provider.enabled) continue;
    if (provider.clientId.length === 0) {
      throw new ConfigValidateError(
        `Missing required field in config: auth.external.${name}.client_id`,
      );
    }
    if (
      name !== "apple" &&
      name !== "google" &&
      (provider.secret === undefined || provider.secret.length === 0)
    ) {
      throw new ConfigValidateError(
        `Missing required field in config: auth.external.${name}.secret`,
      );
    }
  }
}

/**
 * @throws when `project_id` (post-override, post-workdir-basename-fallback) is an explicit
 * empty string. Checked first: the sanitized workdir basename is merged in as a default
 * before `config.toml`, so `project_id` is never empty by the time validation runs — a
 * workdir whose basename sanitizes to `""` fails even with no `project_id` key at all.
 * @throws {InvalidJwtSecretError} when `auth.jwt_secret` is set but too short.
 * @throws {InvalidPortEnvOverrideError} when a `SUPABASE_*_PORT` env/dotenv override doesn't
 * parse as a valid port.
 * @throws {InvalidBoolEnvOverrideError} when a `SUPABASE_*_ENABLED` env/dotenv override
 * doesn't parse as a valid bool.
 * @throws when a configured `api.tls` cert/key file can't be read — see
 * {@link readApiTlsFiles}.
 * @throws when `auth.signing_keys_path` is set, auth is enabled, and the file is missing,
 * malformed, or its first key uses an unsupported algorithm — see
 * {@link resolveConfiguredSigningKeys} and {@link generateAsymmetricGoJwt}.
 * @throws when an email template's `content` is present without `content_path`, or a
 * configured `content_path` file can't be read — see {@link readAuthEmailTemplateContent}.
 * @throws {InvalidAnalyticsBackendEnvOverrideError} when `SUPABASE_ANALYTICS_BACKEND` doesn't
 * parse as one of its accepted values.
 * @throws {ConfigValidateError} for every other validation branch, deferred to a single call
 * to {@link validateResolvedConfig} at the end of this function.
 */
export function resolveLocalConfigValues(
  config: CliConfig,
  hostname: string,
  workdir: string,
  projectEnvValues?: Readonly<Record<string, string>>,
  /**
   * The raw, pre-schema-default TOML document `config` was decoded from, letting checks that
   * hinge on section presence (not the always-defaulted decoded value) inspect the file
   * directly. `undefined` callers simply skip those checks.
   */
  document?: Readonly<Record<string, unknown>>,
  /**
   * Config keys a matched `[remotes.<ref>]` block set at override tier. Every field whose
   * `envOverride*` call (or a downstream {@link validateResolvedConfig} check) can throw on a
   * malformed value belongs in this set — this function returns its whole object or throws, so
   * an unconditional throw anywhere aborts the whole call, even for a field not part of the
   * returned `LocalConfigValues`. Defaults to empty for callers with no `[remotes.<ref>]` block.
   */
  remoteOverrideKeys: ReadonlySet<string> = new Set(),
  /**
   * Default `project_id` supplied by `--project-ref`/the linked project ref before the
   * basename fallback applies. `undefined` for `status`/`stop`, which have no such flag.
   */
  projectIdFallback?: string,
): LocalConfigValues {
  const remoteWins = makeRemoteWins(remoteOverrideKeys);
  // Checked first, before every other field: `config.project_id` is `undefined` only when the
  // key is absent, in which case the sanitized workdir basename (or
  // `projectIdFallback`) applies instead of a file value.
  //
  // Not gated by `remoteWins("project_id")` like the fields below: `envOverride` never turns
  // an already non-empty remote-merged value empty or vice versa, so gating here couldn't
  // change the accept/reject outcome.
  const resolvedProjectId = envOverride(
    "SUPABASE_PROJECT_ID",
    config.project_id ??
      (projectIdFallback !== undefined && projectIdFallback.length > 0
        ? projectIdFallback
        : sanitizeProjectId(basename(workdir))),
    projectEnvValues,
  );

  const apiTlsEnabled = remoteWins("api.tls.enabled")
    ? config.api.tls.enabled
    : envOverrideBool(
        "SUPABASE_API_TLS_ENABLED",
        config.api.tls.enabled,
        "api.tls.enabled",
        projectEnvValues,
      );
  // TLS cert/key validation only runs while `api.enabled`, so this gates on the post-override
  // value, not raw `config.api.enabled`.
  const apiEnabled = remoteWins("api.enabled")
    ? config.api.enabled
    : envOverrideBool("SUPABASE_API_ENABLED", config.api.enabled, "api.enabled", projectEnvValues);
  const apiTlsCertPath = remoteWins("api.tls.cert_path")
    ? config.api.tls.cert_path
    : envOverride("SUPABASE_API_TLS_CERT_PATH", config.api.tls.cert_path, projectEnvValues);
  const apiTlsKeyPath = remoteWins("api.tls.key_path")
    ? config.api.tls.key_path
    : envOverride("SUPABASE_API_TLS_KEY_PATH", config.api.tls.key_path, projectEnvValues);
  if (apiEnabled && apiTlsEnabled) {
    readApiTlsFiles(workdir, apiTlsCertPath, apiTlsKeyPath);
  }
  // `api.port === 0` is rejected only when `api.enabled`, unlike `db.port` below. Resolved once
  // so the check and the URL derivation below share the same overridden value.
  const apiPort = remoteWins("api.port")
    ? config.api.port
    : envOverridePort("SUPABASE_API_PORT", config.api.port, "api.port", projectEnvValues);
  const apiExternalUrl = resolveApiExternalUrl(
    {
      external_url: remoteWins("api.external_url")
        ? config.api.external_url
        : envOverride("SUPABASE_API_EXTERNAL_URL", config.api.external_url, projectEnvValues),
      port: apiPort,
      tls: { enabled: apiTlsEnabled },
    },
    hostname,
  );
  // Unlike `api.port`/`studio.port`/`local_smtp.port` below, `db.port` has no `enabled` gate —
  // it's unconditionally required, and a decoded `0` fails validation.
  const dbPort = remoteWins("db.port")
    ? config.db.port
    : envOverridePort("SUPABASE_DB_PORT", config.db.port, "db.port", projectEnvValues);
  // Validate-only: the shadow's own resolved `majorVersion` comes from
  // `resolveDbBootstrapConfig`, which gates it separately.
  const majorVersion = remoteWins("db.major_version")
    ? config.db.major_version
    : envOverrideMajorVersion(config.db.major_version, projectEnvValues);
  // Validate-only: the actual resolved settings `start` needs are recomputed at their own call
  // site.
  resolveDbSettingsEnvOverrides(config.db.settings, projectEnvValues, remoteOverrideKeys);
  // Validate-only: `start` doesn't otherwise consume `db.network_restrictions.enabled` (only
  // `config push` does).
  if (!remoteWins("db.network_restrictions.enabled")) {
    envOverrideBool(
      "SUPABASE_DB_NETWORK_RESTRICTIONS_ENABLED",
      config.db.network_restrictions.enabled,
      "db.network_restrictions.enabled",
      projectEnvValues,
    );
  }
  // `db.root_key` isn't modeled in `@supabase/config`'s schema, so it's read off the raw
  // pre-schema document. The resolved, decrypted-if-`encrypted:` value is written verbatim into
  // `/etc/postgresql-custom/pgsodium_root.key` on every start.
  const rawRootKeyValue = asRecord(document?.["db"])?.["root_key"];
  if (rawRootKeyValue !== undefined && typeof rawRootKeyValue !== "string") {
    throw new ConfigValidateError(
      "failed to parse config: decoding failed due to the following error(s):\n\n'db.root_key' expected a map or struct",
    );
  }
  const rawRootKey = remoteWins("db.root_key")
    ? rawRootKeyValue
    : envOverride("SUPABASE_DB_ROOT_KEY", rawRootKeyValue, projectEnvValues);
  const rootKey =
    rawRootKey === undefined || rawRootKey.length === 0
      ? POSTGRES_DEFAULT_ROOT_KEY
      : (decryptAuthSecret(rawRootKey, projectEnvValues) ?? POSTGRES_DEFAULT_ROOT_KEY);
  const storageBucketNames =
    config.storage.buckets !== undefined ? Object.keys(config.storage.buckets) : [];
  // `studio.port === 0` is rejected only when `studio.enabled`, same enabled-gated pattern as
  // `api.port` above.
  const studioEnabled = remoteWins("studio.enabled")
    ? config.studio.enabled
    : envOverrideBool(
        "SUPABASE_STUDIO_ENABLED",
        config.studio.enabled,
        "studio.enabled",
        projectEnvValues,
      );
  const studioPort = remoteWins("studio.port")
    ? config.studio.port
    : envOverridePort("SUPABASE_STUDIO_PORT", config.studio.port, "studio.port", projectEnvValues);
  // `envOverride` itself never throws, but `studio.api_url` feeds `validateResolvedConfig`'s
  // URL-parse check below, which does throw on a malformed URL, so this is gated the same way
  // as `studio.enabled`/`studio.port` above.
  const studioApiUrl = remoteWins("studio.api_url")
    ? config.studio.api_url
    : (envOverride("SUPABASE_STUDIO_API_URL", config.studio.api_url, projectEnvValues) ??
      config.studio.api_url);
  // `local_smtp.port === 0` is rejected only when `local_smtp.enabled`; the deprecated
  // `inbucket.enabled` alias is the same underlying flag, not a second one.
  const mailpitEnabled = remoteWins("local_smtp.enabled")
    ? config.local_smtp.enabled
    : envOverrideBool(
        "SUPABASE_LOCAL_SMTP_ENABLED",
        config.local_smtp.enabled,
        "local_smtp.enabled",
        projectEnvValues,
      );
  const mailpitPort = remoteWins("local_smtp.port")
    ? config.local_smtp.port
    : envOverridePort(
        "SUPABASE_LOCAL_SMTP_PORT",
        config.local_smtp.port,
        "local_smtp.port",
        projectEnvValues,
      );
  const jwtSecret = resolveJwtSecret(
    decryptAuthSecret(
      remoteWins("auth.jwt_secret")
        ? config.auth.jwt_secret
        : envOverride("SUPABASE_AUTH_JWT_SECRET", config.auth.jwt_secret, projectEnvValues),
      projectEnvValues,
    ),
  );
  const signingKeysPath = remoteWins("auth.signing_keys_path")
    ? config.auth.signing_keys_path
    : envOverride(
        "SUPABASE_AUTH_SIGNING_KEYS_PATH",
        config.auth.signing_keys_path,
        projectEnvValues,
      );
  // The signing-keys file read only runs when auth is enabled, so a disabled auth section
  // never opens/parses `signing_keys_path`, even a stale or missing one. JWT-secret validation
  // and anon/service_role key generation run unconditionally either way.
  const authEnabled = remoteWins("auth.enabled")
    ? config.auth.enabled
    : envOverrideBool(
        "SUPABASE_AUTH_ENABLED",
        config.auth.enabled,
        "auth.enabled",
        projectEnvValues,
      );
  // `@supabase/config`'s schema only defaults `site_url` when the key is absent, so an
  // explicit `site_url = ""` decodes as `""` with no schema-level error, same gap as
  // `db.port === 0` above.
  const siteUrl = remoteWins("auth.site_url")
    ? config.auth.site_url
    : (envOverride("SUPABASE_AUTH_SITE_URL", config.auth.site_url, projectEnvValues) ??
      config.auth.site_url);
  const jwtIssuer = remoteWins("auth.jwt_issuer")
    ? config.auth.jwt_issuer
    : envOverride("SUPABASE_AUTH_JWT_ISSUER", config.auth.jwt_issuer, projectEnvValues);
  const jwtExpiry = remoteWins("auth.jwt_expiry")
    ? config.auth.jwt_expiry
    : envOverrideUint(
        "SUPABASE_AUTH_JWT_EXPIRY",
        "auth.jwt_expiry",
        config.auth.jwt_expiry,
        projectEnvValues,
      );
  const additionalRedirectUrlsOverride = remoteWins("auth.additional_redirect_urls")
    ? undefined
    : envOverride("SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS", undefined, projectEnvValues);
  const additionalRedirectUrls =
    additionalRedirectUrlsOverride !== undefined
      ? additionalRedirectUrlsOverride.split(",")
      : config.auth.additional_redirect_urls;
  const enableSignup = remoteWins("auth.enable_signup")
    ? config.auth.enable_signup
    : envOverrideBool(
        "SUPABASE_AUTH_ENABLE_SIGNUP",
        config.auth.enable_signup,
        "auth.enable_signup",
        projectEnvValues,
      );
  const enableAnonymousSignIns = remoteWins("auth.enable_anonymous_sign_ins")
    ? config.auth.enable_anonymous_sign_ins
    : envOverrideBool(
        "SUPABASE_AUTH_ENABLE_ANONYMOUS_SIGN_INS",
        config.auth.enable_anonymous_sign_ins,
        "auth.enable_anonymous_sign_ins",
        projectEnvValues,
      );
  const enableRefreshTokenRotation = remoteWins("auth.enable_refresh_token_rotation")
    ? config.auth.enable_refresh_token_rotation
    : envOverrideBool(
        "SUPABASE_AUTH_ENABLE_REFRESH_TOKEN_ROTATION",
        config.auth.enable_refresh_token_rotation,
        "auth.enable_refresh_token_rotation",
        projectEnvValues,
      );
  const refreshTokenReuseInterval = remoteWins("auth.refresh_token_reuse_interval")
    ? config.auth.refresh_token_reuse_interval
    : envOverrideUint(
        "SUPABASE_AUTH_REFRESH_TOKEN_REUSE_INTERVAL",
        "auth.refresh_token_reuse_interval",
        config.auth.refresh_token_reuse_interval,
        projectEnvValues,
      );
  const enableManualLinking = remoteWins("auth.enable_manual_linking")
    ? config.auth.enable_manual_linking
    : envOverrideBool(
        "SUPABASE_AUTH_ENABLE_MANUAL_LINKING",
        config.auth.enable_manual_linking,
        "auth.enable_manual_linking",
        projectEnvValues,
      );
  const minimumPasswordLength = remoteWins("auth.minimum_password_length")
    ? config.auth.minimum_password_length
    : envOverrideUint(
        "SUPABASE_AUTH_MINIMUM_PASSWORD_LENGTH",
        "auth.minimum_password_length",
        config.auth.minimum_password_length,
        projectEnvValues,
      );
  const passwordRequirements = remoteWins("auth.password_requirements")
    ? config.auth.password_requirements
    : envOverrideAuthPasswordRequirements(config.auth.password_requirements, projectEnvValues);
  const authDocument = asRecord(document?.["auth"]);
  const captchaInput = resolveAuthCaptcha(
    authDocument,
    config.auth.captcha,
    projectEnvValues,
    remoteOverrideKeys,
  );
  // Reuses {@link resolveConfiguredSigningKeys}, which already gates the file read on
  // `authEnabled` internally, rather than duplicating that gate here: a disabled-auth config
  // with a configured path must still sign asymmetrically with the default key, not fall back
  // to symmetric HS256.
  const signingKey =
    signingKeysPath !== undefined && signingKeysPath.length > 0
      ? (resolveConfiguredSigningKeys(config, workdir, projectEnvValues, remoteOverrideKeys) ?? [
          DEFAULT_SIGNING_KEY,
        ])[0]
      : undefined;
  // This block only accumulates the inputs passkey/webauthn/hook/mfa/email/smtp/third_party
  // validation needs; the checks themselves run once, later, in the single
  // `validateResolvedConfig` call below (sms/external run separately after it).
  let authInput: AuthInput | undefined;
  if (authEnabled) {
    // `@supabase/config`'s auth schema has no `passkey`/`webauthn` fields at all, so they're
    // read from the raw, post-`env()`-interpolation TOML document instead of the decoded
    // `CliConfig`. `authDocument` is `undefined` when a caller hasn't threaded `document`
    // through yet, in which case these presence-based checks are simply skipped.
    const passkeyDoc = asRecord(authDocument?.["passkey"]);
    const webauthnDoc = asRecord(authDocument?.["webauthn"]);
    // Gated on the raw section already being present: only keys already present in the merged
    // config are env-bindable, so an absent `[auth.passkey]`/`[auth.webauthn]` section is never
    // synthesized from an env override alone.
    const passkeyEnabled = remoteWins("auth.passkey.enabled")
      ? rawUnmodeledBool(passkeyDoc?.["enabled"], "auth.passkey.enabled")
      : passkeyDoc !== undefined
        ? envOverrideBool(
            "SUPABASE_AUTH_PASSKEY_ENABLED",
            rawUnmodeledBool(passkeyDoc["enabled"], "auth.passkey.enabled"),
            "auth.passkey.enabled",
            projectEnvValues,
          )
        : false;
    const configuredRpId =
      typeof webauthnDoc?.["rp_id"] === "string" ? webauthnDoc["rp_id"] : undefined;
    const rpId = remoteWins("auth.webauthn.rp_id")
      ? configuredRpId
      : webauthnDoc !== undefined
        ? envOverride("SUPABASE_AUTH_WEBAUTHN_RP_ID", configuredRpId, projectEnvValues)
        : undefined;
    const rpOriginsOverride = remoteWins("auth.webauthn.rp_origins")
      ? undefined
      : webauthnDoc !== undefined
        ? envOverride("SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS", undefined, projectEnvValues)
        : undefined;
    // A raw or `env(...)`-resolved `rp_origins` string is comma-split, not dropped.
    const rawRpOrigins = webauthnDoc?.["rp_origins"];
    const rpOrigins =
      rpOriginsOverride !== undefined
        ? strToArr(rpOriginsOverride)
        : Array.isArray(rawRpOrigins)
          ? rawRpOrigins
          : typeof rawRpOrigins === "string"
            ? strToArr(rawRpOrigins)
            : undefined;
    const passkey: PasskeyInput | undefined = passkeyEnabled
      ? { webauthnPresent: webauthnDoc !== undefined, rpId, rpOrigins }
      : undefined;

    // Only enabled hooks are forwarded, in {@link HOOK_TYPE_ORDER}.
    const resolvedHooks = resolveAuthHooks(
      authDocument,
      config.auth.hook,
      projectEnvValues,
      remoteOverrideKeys,
    );
    const hooks: Array<HookInput> = HOOK_TYPE_ORDER.filter(
      (hookType) => resolvedHooks[HOOK_TYPE_TO_CAMEL[hookType]].enabled,
    ).map((hookType) => {
      const resolved = resolvedHooks[HOOK_TYPE_TO_CAMEL[hookType]];
      return { type: hookType, uri: resolved.uri, secrets: resolved.secrets };
    });

    const resolvedMfa = resolveAuthMfa(config.auth.mfa, projectEnvValues, remoteOverrideKeys);
    const mfa: ReadonlyArray<MfaFactorInput> = [
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

    readAuthEmailTemplateContent(
      resolveAuthEmail(config.auth.email, authDocument, projectEnvValues, remoteOverrideKeys),
      workdir,
    );

    const resolvedSmtp = resolveAuthEmailSmtp(authDocument, projectEnvValues, remoteOverrideKeys);
    const smtp: SmtpInput | undefined =
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

    const thirdParty = resolveThirdPartyProviders(
      config.auth.third_party,
      projectEnvValues,
      remoteOverrideKeys,
    );

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
  const functionSlugs = Object.keys(config.functions);
  // `edge_runtime.deno_version` is checked unconditionally, with no `edge_runtime.enabled`
  // gate, unlike `studio.port`/`local_smtp.port` above.
  const denoVersion = remoteWins("edge_runtime.deno_version")
    ? config.edge_runtime.deno_version
    : envOverrideDenoVersion(config.edge_runtime.deno_version, projectEnvValues);

  // When `analytics.enabled` and `analytics.backend == "bigquery"`, all three GCP fields are
  // required. Backend-enum validation is covered at decode time for the config.toml-sourced
  // value by `@supabase/config`'s schema, but not for the `SUPABASE_ANALYTICS_BACKEND`
  // env-override path — see {@link envOverrideAnalyticsBackend} for that case.
  const analyticsEnabled = remoteWins("analytics.enabled")
    ? config.analytics.enabled
    : envOverrideBool(
        "SUPABASE_ANALYTICS_ENABLED",
        config.analytics.enabled,
        "analytics.enabled",
        projectEnvValues,
      );
  const analyticsBackend = envOverrideAnalyticsBackend(
    config.analytics.backend,
    projectEnvValues,
    remoteWins("analytics.backend"),
  );
  const gcpProjectId = remoteWins("analytics.gcp_project_id")
    ? config.analytics.gcp_project_id
    : envOverride(
        "SUPABASE_ANALYTICS_GCP_PROJECT_ID",
        config.analytics.gcp_project_id,
        projectEnvValues,
      );
  const gcpProjectNumber = remoteWins("analytics.gcp_project_number")
    ? config.analytics.gcp_project_number
    : envOverride(
        "SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER",
        config.analytics.gcp_project_number,
        projectEnvValues,
      );
  const gcpJwtPath = remoteWins("analytics.gcp_jwt_path")
    ? config.analytics.gcp_jwt_path
    : envOverride(
        "SUPABASE_ANALYTICS_GCP_JWT_PATH",
        config.analytics.gcp_jwt_path,
        projectEnvValues,
      );

  // The webhooks check isn't "the user disabled a feature": an omitted `enabled` key in a
  // present `[experimental.webhooks]` section is rejected too — the section exists only so it
  // can be turned on, never explicitly off. This hinges on TOML-section presence, which the
  // schema's decode-time default erases (`experimental.webhooks` always decodes to
  // `{ enabled: false }` even when absent), so this reads the raw document instead.
  const experimentalDocument = asRecord(document?.["experimental"]);
  const webhooksPresent = asRecord(experimentalDocument?.["webhooks"]) !== undefined;
  // A malformed JSON override needs no separate error path: it flows through unchanged and
  // `validateResolvedConfig`'s existing JSON-validity check reports it.
  const webhooksEnabled = remoteWins("experimental.webhooks.enabled")
    ? config.experimental.webhooks?.enabled === true
    : envOverrideBool(
        "SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED",
        config.experimental.webhooks?.enabled === true,
        "experimental.webhooks.enabled",
        projectEnvValues,
      );
  const pgdeltaFormatOptions = remoteWins("experimental.pgdelta.format_options")
    ? (config.experimental.pgdelta?.format_options ?? "")
    : (envOverride(
        "SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS",
        config.experimental.pgdelta?.format_options,
        projectEnvValues,
      ) ?? "");

  // Every pure validation check runs in one place, here, rather than interleaved with this
  // function's 3 I/O reads (signing keys, api.tls cert/key, email content) at their original
  // relative positions — a config broken in two independent ways can report a different one of
  // those errors than if checks ran interleaved.
  const apiInput: ApiInput = {
    enabled: apiEnabled,
    port: apiPort,
    tls: { enabled: apiTlsEnabled, certPath: apiTlsCertPath, keyPath: apiTlsKeyPath },
  };
  const dbInput: DbInput = { port: dbPort, majorVersion };
  const studioInput: StudioInput = {
    enabled: studioEnabled,
    port: studioPort,
    apiUrl: studioApiUrl,
  };
  const localSmtpInput: LocalSmtpInput = { enabled: mailpitEnabled, port: mailpitPort };
  const analyticsInput: AnalyticsInput = {
    enabled: analyticsEnabled,
    backend: analyticsBackend,
    gcpProjectId: gcpProjectId ?? "",
    gcpProjectNumber: gcpProjectNumber ?? "",
    gcpJwtPath: gcpJwtPath ?? "",
  };
  const experimentalInput: ExperimentalInput = {
    webhooksPresent,
    webhooksEnabled,
    pgdeltaFormatOptions,
  };

  const input: ConfigValidationInput = {
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
  validateResolvedConfig(input);
  // sms/external run after the shared validation call, since both need the env-override-aware
  // resolved value rather than the raw decoded config it validates.
  if (authEnabled) {
    validateAuthSmsProviders(authDocument, config.auth.sms, projectEnvValues, remoteOverrideKeys);
    validateAuthExternalProviders(
      authDocument,
      config.auth.external,
      projectEnvValues,
      remoteOverrideKeys,
    );
  }

  // Decrypted like `auth.email.smtp.pass`/`auth.captcha.secret`.
  const openaiApiKey = remoteWins("studio.openai_api_key")
    ? decryptAuthSecret(config.studio.openai_api_key, projectEnvValues)
    : decryptAuthSecret(
        envOverride(
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
    // Decrypted like `anon_key`/`service_role_key` below.
    publishableKey: resolveOpaqueKey(
      remoteWins("auth.publishable_key")
        ? decryptAuthSecret(config.auth.publishable_key, projectEnvValues)
        : decryptAuthSecret(
            envOverride(
              "SUPABASE_AUTH_PUBLISHABLE_KEY",
              config.auth.publishable_key,
              projectEnvValues,
            ),
            projectEnvValues,
          ),
      defaultPublishableKey,
    ),
    secretKey: resolveOpaqueKey(
      remoteWins("auth.secret_key")
        ? decryptAuthSecret(config.auth.secret_key, projectEnvValues)
        : decryptAuthSecret(
            envOverride("SUPABASE_AUTH_SECRET_KEY", config.auth.secret_key, projectEnvValues),
            projectEnvValues,
          ),
      defaultSecretKey,
    ),
    jwtSecret,
    anonKey: resolveSignedKey(
      decryptAuthSecret(
        remoteWins("auth.anon_key")
          ? config.auth.anon_key
          : envOverride("SUPABASE_AUTH_ANON_KEY", config.auth.anon_key, projectEnvValues),
        projectEnvValues,
      ),
      jwtSecret,
      signingKey,
      "anon",
    ),
    serviceRoleKey: resolveSignedKey(
      decryptAuthSecret(
        remoteWins("auth.service_role_key")
          ? config.auth.service_role_key
          : envOverride(
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
    // Sanitized here, not in `input.projectId` above: `validateResolvedConfig`'s check is
    // presence-only and must see the raw value to reject an explicit `project_id = ""`.
    projectId: sanitizeProjectId(resolvedProjectId ?? ""),
    edgeRuntimeDenoVersion: denoVersion,
  };
}

/**
 * Resolves the local JWKS document for the future native `start` port; a fetch failure fails
 * the whole `start` command. Kept separate from {@link resolveLocalConfigValues} — synchronous
 * and run on every `stop`/`status` — so this function's network round-trip doesn't tax those
 * two commands.
 *
 * `jwtSecret` is accepted as a parameter (the same value {@link resolveLocalConfigValues}
 * already resolves) rather than recomputed, so the two functions never disagree on it.
 * `authEnabled`/`signingKeysPath` are recomputed here, keeping this function self-contained.
 *
 * The oct-JWT-secret fallback below is gated on `signingKeysPath` emptiness, not `authEnabled`:
 * a configured path with auth disabled still resolves the signing keys to the default (never
 * reads the file), but `signingKeysPath` stays non-empty, so the fallback stays skipped.
 *
 * @throws {ConfigValidateError} when more than one `auth.third_party.*` provider is enabled,
 * an enabled provider is missing a required field, or the remote JWKS fetch fails.
 *
 * `remoteOverrideKeys` lets a matched remote block's `auth.signing_keys_path`/
 * `auth.third_party.*` value win over a conflicting `SUPABASE_AUTH_*` override, same as
 * {@link resolveLocalConfigValues}'s parameter of the same name.
 */
export async function resolveLocalJwks(
  config: CliConfig,
  workdir: string,
  jwtSecret: string,
  projectEnvValues?: Readonly<Record<string, string>>,
  remoteOverrideKeys: ReadonlySet<string> = new Set(),
): Promise<string> {
  const remoteWins = makeRemoteWins(remoteOverrideKeys);
  const signingKeysPath = remoteWins("auth.signing_keys_path")
    ? config.auth.signing_keys_path
    : envOverride(
        "SUPABASE_AUTH_SIGNING_KEYS_PATH",
        config.auth.signing_keys_path,
        projectEnvValues,
      );
  // Every resolved config carries the default ES256 key, regardless of `auth.enabled`. It's
  // only ever replaced by a configured `signing_keys_path` file, and only when that file is
  // actually read (gated on `auth.enabled` — see {@link resolveConfiguredSigningKeys}). So JWKS
  // resolution always publishes either the file's keys or this default, never neither —
  // `GOTRUE_JWT_KEYS` signs with the same default, so the two must never disagree.
  const signingKeys: ReadonlyArray<Jwk> = resolveConfiguredSigningKeys(
    config,
    workdir,
    projectEnvValues,
    remoteOverrideKeys,
  ) ?? [DEFAULT_SIGNING_KEY];

  // Built as a `ThirdPartyProvidersLike` (every provider's full field set, including auth0's
  // `tenant_region`) rather than the validation-only `ThirdPartyInput`, since
  // {@link resolveThirdPartyIssuerUrl} needs the full set to build the issuer URL.
  const thirdParty: ThirdPartyProvidersLike = {
    firebase: {
      enabled: remoteWins("auth.third_party.firebase.enabled")
        ? config.auth.third_party.firebase.enabled
        : envOverrideBool(
            "SUPABASE_AUTH_THIRD_PARTY_FIREBASE_ENABLED",
            config.auth.third_party.firebase.enabled,
            "auth.third_party.firebase.enabled",
            projectEnvValues,
          ),
      project_id: remoteWins("auth.third_party.firebase.project_id")
        ? config.auth.third_party.firebase.project_id
        : envOverride(
            "SUPABASE_AUTH_THIRD_PARTY_FIREBASE_PROJECT_ID",
            config.auth.third_party.firebase.project_id,
            projectEnvValues,
          ),
    },
    auth0: {
      enabled: remoteWins("auth.third_party.auth0.enabled")
        ? config.auth.third_party.auth0.enabled
        : envOverrideBool(
            "SUPABASE_AUTH_THIRD_PARTY_AUTH0_ENABLED",
            config.auth.third_party.auth0.enabled,
            "auth.third_party.auth0.enabled",
            projectEnvValues,
          ),
      tenant: remoteWins("auth.third_party.auth0.tenant")
        ? config.auth.third_party.auth0.tenant
        : envOverride(
            "SUPABASE_AUTH_THIRD_PARTY_AUTH0_TENANT",
            config.auth.third_party.auth0.tenant,
            projectEnvValues,
          ),
      tenant_region: remoteWins("auth.third_party.auth0.tenant_region")
        ? config.auth.third_party.auth0.tenant_region
        : envOverride(
            "SUPABASE_AUTH_THIRD_PARTY_AUTH0_TENANT_REGION",
            config.auth.third_party.auth0.tenant_region,
            projectEnvValues,
          ),
    },
    aws_cognito: {
      enabled: remoteWins("auth.third_party.aws_cognito.enabled")
        ? config.auth.third_party.aws_cognito.enabled
        : envOverrideBool(
            "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_ENABLED",
            config.auth.third_party.aws_cognito.enabled,
            "auth.third_party.aws_cognito.enabled",
            projectEnvValues,
          ),
      user_pool_id: remoteWins("auth.third_party.aws_cognito.user_pool_id")
        ? config.auth.third_party.aws_cognito.user_pool_id
        : envOverride(
            "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_USER_POOL_ID",
            config.auth.third_party.aws_cognito.user_pool_id,
            projectEnvValues,
          ),
      user_pool_region: remoteWins("auth.third_party.aws_cognito.user_pool_region")
        ? config.auth.third_party.aws_cognito.user_pool_region
        : envOverride(
            "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_USER_POOL_REGION",
            config.auth.third_party.aws_cognito.user_pool_region,
            projectEnvValues,
          ),
    },
    clerk: {
      enabled: remoteWins("auth.third_party.clerk.enabled")
        ? config.auth.third_party.clerk.enabled
        : envOverrideBool(
            "SUPABASE_AUTH_THIRD_PARTY_CLERK_ENABLED",
            config.auth.third_party.clerk.enabled,
            "auth.third_party.clerk.enabled",
            projectEnvValues,
          ),
      domain: remoteWins("auth.third_party.clerk.domain")
        ? config.auth.third_party.clerk.domain
        : envOverride(
            "SUPABASE_AUTH_THIRD_PARTY_CLERK_DOMAIN",
            config.auth.third_party.clerk.domain,
            projectEnvValues,
          ),
    },
    workos: {
      enabled: remoteWins("auth.third_party.workos.enabled")
        ? config.auth.third_party.workos.enabled
        : envOverrideBool(
            "SUPABASE_AUTH_THIRD_PARTY_WORKOS_ENABLED",
            config.auth.third_party.workos.enabled,
            "auth.third_party.workos.enabled",
            projectEnvValues,
          ),
      issuer_url: remoteWins("auth.third_party.workos.issuer_url")
        ? config.auth.third_party.workos.issuer_url
        : envOverride(
            "SUPABASE_AUTH_THIRD_PARTY_WORKOS_ISSUER_URL",
            config.auth.third_party.workos.issuer_url,
            projectEnvValues,
          ),
    },
  };

  // This function is called unconditionally, regardless of `auth.enabled`, but
  // `resolveThirdPartyIssuerUrl`'s "at most one enabled" + required-field checks are only
  // meaningful while auth is enabled — `resolveLocalConfigValues` already ran the equivalent
  // check in that case. When auth is disabled, that validation is (correctly) skipped, so this
  // uses the unchecked, no-throw issuer-url builder instead.
  const authEnabled = remoteWins("auth.enabled")
    ? config.auth.enabled
    : envOverrideBool(
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
      throw new ConfigValidateError(cause instanceof Error ? cause.message : String(cause));
    }
  } else {
    issuerUrl = thirdPartyIssuerUrlUnchecked(thirdParty);
  }

  const keys: unknown[] = [];
  // A provider's own issuer-url resolution can return the empty string with no validation
  // (e.g. workos's is a raw field read), so an enabled-but-unconfigured provider must be
  // tolerated, not fetched.
  if (issuerUrl !== undefined && issuerUrl.length > 0) {
    try {
      keys.push(...(await resolveRemoteJwks(issuerUrl)));
    } catch (cause) {
      throw new ConfigValidateError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  keys.push(...signingKeys.map(toPublicJwk));
  if (signingKeysPath === undefined || signingKeysPath.length === 0) {
    keys.push({ kty: "oct", k: Buffer.from(jwtSecret).toString("base64url") });
  }

  return JSON.stringify({ keys });
}
