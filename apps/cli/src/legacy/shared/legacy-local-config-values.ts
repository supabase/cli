import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { ProjectConfig } from "@supabase/config";
import { defaultJwtSecret, defaultPublishableKey, defaultSecretKey } from "@supabase/stack/effect";
import { Schema } from "effect";

import { legacyResolveApiExternalUrl } from "./legacy-api-url.ts";
import { legacyParseGoBool } from "./legacy-db-config.toml-read.ts";
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
 * Thrown by {@link envOverridePort} when a `SUPABASE_*_PORT` env/dotenv
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
 * Port-flavored sibling of {@link envOverride}/{@link legacyEnvOverrideBool}
 * for `SUPABASE_*_PORT` fields Go decodes as `uint16` rather than a plain
 * string. Unlike the boolean sibling — which intentionally falls back to
 * `configured` on a malformed override — a bad port override is a genuine
 * Go-parity hard failure (see {@link LegacyInvalidPortEnvOverrideError}), not
 * a leniency case: Go never proceeds with the pre-override value on a decode
 * error, it fails config loading outright.
 */
function envOverridePort(
  name: string,
  configuredPort: number,
  dottedFieldPath: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  const value = envOverride(name, undefined, projectEnvValues);
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
 */
function envOverride(
  name: string,
  configured: string | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const value = projectEnvValues?.[name] ?? process.env[name];
  return value !== undefined && value.length > 0 ? value : configured;
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
 * Boolean-flavored sibling of {@link envOverride} for `SUPABASE_*` fields Go
 * decodes as a native bool (`api.tls.enabled`, `auth.enabled`, and every other
 * `<section>.enabled` gate `status`/`stop` read — see `status.values.ts`)
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
 * Exported (not just used internally) because `status.values.ts`'s own
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
  const value = envOverride(name, undefined, projectEnvValues);
  if (value === undefined) return configured;
  const parsed = legacyParseGoBool(value);
  if (parsed === undefined) {
    throw new LegacyInvalidBoolEnvOverrideError(dottedFieldPath, value);
  }
  return parsed;
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
function loadFirstSigningKey(workdir: string, signingKeysPath: string): LegacyJwk | undefined {
  const absolutePath = isAbsolute(signingKeysPath)
    ? signingKeysPath
    : join(workdir, "supabase", signingKeysPath);

  let contents: string;
  try {
    contents = readFileSync(absolutePath, "utf8");
  } catch (cause) {
    throw new Error(
      `failed to read signing keys: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  let jwks: ReadonlyArray<LegacyJwk>;
  try {
    jwks = decodeLegacyJwks(JSON.parse(contents));
  } catch (cause) {
    throw new Error(
      `failed to decode signing keys: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return jwks[0];
}

/**
 * @throws {LegacyInvalidJwtSecretError} when `auth.jwt_secret` is set but too short.
 * @throws {LegacyInvalidPortEnvOverrideError} when a `SUPABASE_*_PORT` env/dotenv
 * override doesn't parse as a valid port.
 * @throws {LegacyInvalidBoolEnvOverrideError} when a `SUPABASE_*_ENABLED` env/dotenv
 * override doesn't parse as a valid bool.
 * @throws when `auth.signing_keys_path` is set but the file is missing, malformed,
 * or its first key uses an unsupported algorithm — see {@link legacyGenerateAsymmetricGoJwt}.
 */
export function legacyResolveLocalConfigValues(
  config: ProjectConfig,
  hostname: string,
  workdir: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined = undefined,
): LegacyLocalConfigValues {
  // Go's `status` reads `utils.Config.Api.Port`/`ExternalUrl`/`Tls.Enabled`
  // after Viper's AutomaticEnv has already applied any `SUPABASE_API_PORT`/
  // `SUPABASE_API_EXTERNAL_URL`/`SUPABASE_API_TLS_ENABLED` override
  // (`config.go:529-535,799-809`), so the values fed into
  // `legacyResolveApiExternalUrl`'s own `external_url`-wins-else-
  // `scheme://host:port` derivation (which picks `https` vs `http` from
  // `tls.enabled`) must be the overridden ones too.
  const apiExternalUrl = legacyResolveApiExternalUrl(
    {
      external_url: envOverride(
        "SUPABASE_API_EXTERNAL_URL",
        config.api.external_url,
        projectEnvValues,
      ),
      port: envOverridePort("SUPABASE_API_PORT", config.api.port, "api.port", projectEnvValues),
      tls: {
        enabled: legacyEnvOverrideBool(
          "SUPABASE_API_TLS_ENABLED",
          config.api.tls.enabled,
          "api.tls.enabled",
          projectEnvValues,
        ),
      },
    },
    hostname,
  );
  // Unlike `api.port`/`studio.port`/`local_smtp.port` below, `db.port` has no
  // `enabled` gate in Go's `Config.Validate` — it's unconditionally required,
  // and a decoded `0` (e.g. `SUPABASE_DB_PORT=0`) fails validation with this
  // exact message (`pkg/config/config.go:1031-1032`) before `status`/`stop`
  // render anything, same wording already used for the `db query`/`test db`
  // path (`legacy-db-config.toml-read.ts:1380`). This check is intentionally
  // NOT inside `envOverridePort` itself: that helper is generic across all
  // four port fields, and Go's zero-rejection for the other three is
  // conditional on their section's `enabled` flag (`config.go:1006-1009,
  // 1070-1073,1081-1084`), so adding it there would wrongly reject e.g.
  // `SUPABASE_STUDIO_PORT=0` even when `studio.enabled` is `false`.
  const dbPort = envOverridePort("SUPABASE_DB_PORT", config.db.port, "db.port", projectEnvValues);
  if (dbPort === 0) {
    throw new Error("Missing required field in config: db.port");
  }
  const studioPort = envOverridePort(
    "SUPABASE_STUDIO_PORT",
    config.studio.port,
    "studio.port",
    projectEnvValues,
  );
  const mailpitPort = envOverridePort(
    "SUPABASE_LOCAL_SMTP_PORT",
    config.local_smtp.port,
    "local_smtp.port",
    projectEnvValues,
  );
  const jwtSecret = resolveJwtSecret(
    envOverride("SUPABASE_AUTH_JWT_SECRET", config.auth.jwt_secret, projectEnvValues),
  );
  const signingKeysPath = envOverride(
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
  const signingKey =
    authEnabled && signingKeysPath !== undefined && signingKeysPath.length > 0
      ? loadFirstSigningKey(workdir, signingKeysPath)
      : undefined;

  return {
    apiUrl: apiExternalUrl,
    restUrl: apiUrlWithPath(apiExternalUrl, "/rest/v1"),
    graphqlUrl: apiUrlWithPath(apiExternalUrl, "/graphql/v1"),
    functionsUrl: apiUrlWithPath(apiExternalUrl, "/functions/v1"),
    mcpUrl: apiUrlWithPath(apiExternalUrl, "/mcp"),
    studioUrl: `http://${hostname}:${studioPort}`,
    mailpitUrl: `http://${hostname}:${mailpitPort}`,
    dbUrl: `postgresql://postgres:${DEFAULT_DB_PASSWORD}@${hostname}:${dbPort}/postgres`,
    publishableKey: resolveOpaqueKey(
      envOverride("SUPABASE_AUTH_PUBLISHABLE_KEY", config.auth.publishable_key, projectEnvValues),
      defaultPublishableKey,
    ),
    secretKey: resolveOpaqueKey(
      envOverride("SUPABASE_AUTH_SECRET_KEY", config.auth.secret_key, projectEnvValues),
      defaultSecretKey,
    ),
    jwtSecret,
    anonKey: resolveSignedKey(
      envOverride("SUPABASE_AUTH_ANON_KEY", config.auth.anon_key, projectEnvValues),
      jwtSecret,
      signingKey,
      "anon",
    ),
    serviceRoleKey: resolveSignedKey(
      envOverride("SUPABASE_AUTH_SERVICE_ROLE_KEY", config.auth.service_role_key, projectEnvValues),
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
