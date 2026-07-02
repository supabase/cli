import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { ProjectConfig } from "@supabase/config";
import { defaultJwtSecret, defaultPublishableKey, defaultSecretKey } from "@supabase/stack/effect";
import { Schema } from "effect";

import { legacyResolveApiExternalUrl } from "./legacy-api-url.ts";
import {
  legacyGenerateAsymmetricGoJwt,
  legacyGenerateGoJwt,
  type LegacyJwk,
} from "./legacy-go-jwt.ts";

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

export interface LegacyLocalConfigValues {
  readonly apiUrl: string;
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
 * Go's `Config.Load` binds Viper with `SetEnvPrefix("SUPABASE")` +
 * `AutomaticEnv()` + a `.`→`_` key replacer (`pkg/config/config.go:529-535`),
 * so any config field can be overridden by a `SUPABASE_<DOTTED_KEY>` env var —
 * this resolves it for exactly the 5 auth fields this module reads, at the
 * same higher-than-config.toml precedence Viper gives env vars. An empty env
 * var is treated as unset, matching Viper's default (`AllowEmptyEnv` is never
 * enabled in `config.go`).
 */
function envOverride(name: string, configured: string | undefined): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : configured;
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
  alg: Schema.optionalKey(Schema.String),
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
 * read and JSON-decoded into `[]JWK`. Only the first key is ever used
 * ({@link resolveSignedKey}), matching `generateJWT`'s `a.SigningKeys[0]`.
 *
 * Uses `node:fs` directly (not the `FileSystem` Effect service other Go-parity
 * resolvers in `legacy/` use for file reads) so this function — and its large
 * existing test surface — can stay a plain synchronous resolver; this is an
 * optional, rarely-configured field, not worth threading Effect dependencies
 * through `legacyStatusValues`/`status.handler.ts` for.
 */
function loadFirstSigningKey(workdir: string, signingKeysPath: string): LegacyJwk | undefined {
  const absolutePath = isAbsolute(signingKeysPath)
    ? signingKeysPath
    : join(workdir, "supabase", signingKeysPath);
  const contents = readFileSync(absolutePath, "utf8");
  const jwks = decodeLegacyJwks(JSON.parse(contents));
  return jwks[0];
}

/**
 * @throws {LegacyInvalidJwtSecretError} when `auth.jwt_secret` is set but too short.
 * @throws when `auth.signing_keys_path` is set but the file is missing, malformed,
 * or its first key uses an unsupported algorithm — see {@link legacyGenerateAsymmetricGoJwt}.
 */
export function legacyResolveLocalConfigValues(
  config: ProjectConfig,
  hostname: string,
  workdir: string,
): LegacyLocalConfigValues {
  const apiExternalUrl = legacyResolveApiExternalUrl(config.api, hostname);
  const jwtSecret = resolveJwtSecret(
    envOverride("SUPABASE_AUTH_JWT_SECRET", config.auth.jwt_secret),
  );
  const signingKeysPath = config.auth.signing_keys_path;
  const signingKey =
    signingKeysPath !== undefined && signingKeysPath.length > 0
      ? loadFirstSigningKey(workdir, signingKeysPath)
      : undefined;

  return {
    apiUrl: apiExternalUrl,
    restUrl: apiUrlWithPath(apiExternalUrl, "/rest/v1"),
    graphqlUrl: apiUrlWithPath(apiExternalUrl, "/graphql/v1"),
    functionsUrl: apiUrlWithPath(apiExternalUrl, "/functions/v1"),
    mcpUrl: apiUrlWithPath(apiExternalUrl, "/mcp"),
    studioUrl: `http://${hostname}:${config.studio.port}`,
    mailpitUrl: `http://${hostname}:${config.local_smtp.port}`,
    dbUrl: `postgresql://postgres:${DEFAULT_DB_PASSWORD}@${hostname}:${config.db.port}/postgres`,
    publishableKey: resolveOpaqueKey(
      envOverride("SUPABASE_AUTH_PUBLISHABLE_KEY", config.auth.publishable_key),
      defaultPublishableKey,
    ),
    secretKey: resolveOpaqueKey(
      envOverride("SUPABASE_AUTH_SECRET_KEY", config.auth.secret_key),
      defaultSecretKey,
    ),
    jwtSecret,
    anonKey: resolveSignedKey(
      envOverride("SUPABASE_AUTH_ANON_KEY", config.auth.anon_key),
      jwtSecret,
      signingKey,
      "anon",
    ),
    serviceRoleKey: resolveSignedKey(
      envOverride("SUPABASE_AUTH_SERVICE_ROLE_KEY", config.auth.service_role_key),
      jwtSecret,
      signingKey,
      "service_role",
    ),
    storageS3Url: apiUrlWithPath(apiExternalUrl, "/storage/v1/s3"),
    storageS3AccessKeyId: DEFAULT_S3_ACCESS_KEY_ID,
    storageS3SecretAccessKey: DEFAULT_S3_SECRET_ACCESS_KEY,
    storageS3Region: DEFAULT_S3_REGION,
  };
}
