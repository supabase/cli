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
 * Go's `Config.Validate` TLS branch (`pkg/config/config.go:1006-1027`), gated
 * on `api.enabled` same as the caller: a cert path with no key path (or vice
 * versa) is a hard config error; when both are set, each file is read to
 * confirm it's actually reachable, matching Go's `fs.ReadFile` calls (Go
 * caches the bytes for `start` to serve as `CertContent`/`KeyContent` —
 * `status` has no use for the bytes, only the same validation outcome, so
 * they're discarded here). Neither path set is NOT an error in Go — `Validate`
 * only rejects the "exactly one set" case, so `tls.enabled = true` with no
 * cert/key configured at all still loads (it just can't serve TLS at `start`
 * time), mirrored here by returning without throwing.
 *
 * Go joins both paths unconditionally with the `supabase/` dir — no
 * `filepath.IsAbs` guard (`config.go:961-965` uses `path.Join`, which absorbs
 * a leading `/`) — unlike {@link loadFirstSigningKey}'s `signing_keys_path`,
 * which Go does guard with `filepath.IsAbs` (`config.go:928-929`). Matches the
 * identical Kong-side validation already ported for `seed buckets`/`storage`
 * in `legacy-storage-credentials.ts`'s `validateLocalKongTls`.
 *
 * Uses `node:fs` directly for the same reason as {@link loadFirstSigningKey}:
 * this stays a plain synchronous resolver rather than threading the Effect
 * `FileSystem` service through `legacyStatusValues`/`status.handler.ts`.
 */
function validateLocalApiTls(
  workdir: string,
  certPath: string | undefined,
  keyPath: string | undefined,
): void {
  const hasCert = certPath !== undefined && certPath.length > 0;
  const hasKey = keyPath !== undefined && keyPath.length > 0;

  if (hasCert && !hasKey) {
    throw new Error("Missing required field in config: api.tls.key_path");
  }
  if (hasKey && !hasCert) {
    throw new Error("Missing required field in config: api.tls.cert_path");
  }
  if (!hasCert) return;

  try {
    readFileSync(join(workdir, "supabase", certPath), "utf8");
  } catch (cause) {
    throw new Error(
      `failed to read TLS cert: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  try {
    readFileSync(join(workdir, "supabase", keyPath!), "utf8");
  } catch (cause) {
    throw new Error(
      `failed to read TLS key: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Go's supported `db.major_version` values (`pkg/config/config.go:1039-1040`, the
 * `case 13, 14:`/`case 15, 17:` branches — both are no-ops in Go's `Validate`, the
 * 15/17 sub-branch only rewrites `Db.Image` for OrioleDB, which `status`/`stop`
 * never read). `12` and `0` get their own dedicated messages below; anything else
 * falls through to the generic invalid-value message.
 */
const SUPPORTED_DB_MAJOR_VERSIONS = new Set([13, 14, 15, 17]);

/**
 * Go's `Config.Validate`'s `switch c.Db.MajorVersion` (`pkg/config/config.go:
 * 1034-1061`): `0` is the zero-value/missing case, `12` has a dedicated
 * unsupported-version message (with a migration-docs link), `13`/`14`/`15`/`17`
 * are supported (the 15/17 OrioleDB image-rewrite sub-branch is skipped here —
 * irrelevant to `status`/`stop`, which never read `db.image`), and anything else
 * is the generic invalid-value message. Mirrors the equivalent check already
 * ported for the `db query`/`test db` path (`legacy-db-config.toml-read.ts:
 * 1414-1429`), except this one honors Go's exact `case 0:` message rather than
 * folding it into the generic "Invalid db.major_version" text.
 */
function validateDbMajorVersion(majorVersion: number): void {
  if (majorVersion === 0) {
    throw new Error("Missing required field in config: db.major_version");
  }
  if (majorVersion === 12) {
    throw new Error(
      "Postgres version 12.x is unsupported. To use the CLI, either start a new project or follow project migration steps here: https://supabase.com/docs/guides/database#migrating-between-projects.",
    );
  }
  if (!SUPPORTED_DB_MAJOR_VERSIONS.has(majorVersion)) {
    throw new Error(`Failed reading config: Invalid db.major_version: ${majorVersion}.`);
  }
}

/**
 * `SUPABASE_DB_MAJOR_VERSION` sibling of {@link envOverridePort} for the one
 * numeric field Go decodes as `uint` rather than `uint16` (`pkg/config/db.go:87`)
 * — same generic Viper `AutomaticEnv` binding (`config.go:576-586`), same
 * mapstructure hard-fail-on-bad-value semantics as the port/bool overrides, but
 * with no upper-bound cap. A non-digit override folds into the same generic
 * "Invalid db.major_version" message {@link validateDbMajorVersion} produces for
 * an out-of-set numeric value, since Go's own decode failure and `Validate`
 * failure for this field aren't independently distinguishable from the CLI's
 * output the way ports/bools are.
 */
function envOverrideMajorVersion(
  configured: number,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  const value = envOverride("SUPABASE_DB_MAJOR_VERSION", undefined, projectEnvValues);
  if (value === undefined) return configured;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Failed reading config: Invalid db.major_version: ${value}.`);
  }
  return Number(value);
}

/**
 * Go's `Config.Validate`'s `switch c.EdgeRuntime.DenoVersion` (`pkg/config/
 * config.go:1164-1173`): `0` is the zero-value/missing case, `1`/`2` are
 * supported (the `1` sub-branch only rewrites `EdgeRuntime.Image` to the
 * `deno1` tag, which `status`/`stop` never read), and anything else is the
 * generic invalid-value message. Unlike `studio.port`/`local_smtp.port`, this
 * switch is NOT nested inside an `edge_runtime.enabled` gate — it runs
 * unconditionally, so a disabled edge runtime with an invalid `deno_version`
 * still fails config loading. Mirrors the equivalent check already ported for
 * the `db diff`/pg-delta path (`legacy-db-config.toml-read.ts:1482-1499`).
 */
function validateDenoVersion(denoVersion: number): void {
  if (denoVersion === 0) {
    throw new Error("Missing required field in config: edge_runtime.deno_version");
  }
  if (denoVersion !== 1 && denoVersion !== 2) {
    throw new Error(`Failed reading config: Invalid edge_runtime.deno_version: ${denoVersion}.`);
  }
}

/**
 * `SUPABASE_EDGE_RUNTIME_DENO_VERSION` sibling of {@link envOverrideMajorVersion}
 * — same generic Viper `AutomaticEnv` binding, same mapstructure
 * hard-fail-on-bad-value semantics, no upper-bound cap. A non-digit override
 * folds into the same generic "Invalid edge_runtime.deno_version" message
 * {@link validateDenoVersion} produces for an out-of-set numeric value.
 */
function envOverrideDenoVersion(
  configured: number,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): number {
  const value = envOverride("SUPABASE_EDGE_RUNTIME_DENO_VERSION", undefined, projectEnvValues);
  if (value === undefined) return configured;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Failed reading config: Invalid edge_runtime.deno_version: ${value}.`);
  }
  return Number(value);
}

/**
 * @throws {LegacyInvalidJwtSecretError} when `auth.jwt_secret` is set but too short.
 * @throws {LegacyInvalidPortEnvOverrideError} when a `SUPABASE_*_PORT` env/dotenv
 * override doesn't parse as a valid port.
 * @throws {LegacyInvalidBoolEnvOverrideError} when a `SUPABASE_*_ENABLED` env/dotenv
 * override doesn't parse as a valid bool.
 * @throws when `api.tls.enabled` is set with only one of `cert_path`/`key_path`, or a
 * configured file can't be read — see {@link validateLocalApiTls}.
 * @throws when `api.enabled` is true and `api.port` (post-override) is `0`.
 * @throws when `db.port` (post-override) is `0`.
 * @throws when `db.major_version` (post-override) is `0`, `12`, or otherwise
 * unsupported — see {@link validateDbMajorVersion}.
 * @throws when `edge_runtime.deno_version` (post-override) is `0` or otherwise
 * not `1`/`2` — see {@link validateDenoVersion}. Unconditional, not gated on
 * `edge_runtime.enabled`.
 * @throws when `studio.enabled` is true and `studio.port` (post-override) is `0`.
 * @throws when `local_smtp.enabled` is true and `local_smtp.port` (post-override) is `0`.
 * @throws when `auth.enabled` is true and `auth.site_url` is empty.
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
  if (apiEnabled && apiTlsEnabled) {
    validateLocalApiTls(
      workdir,
      envOverride("SUPABASE_API_TLS_CERT_PATH", config.api.tls.cert_path, projectEnvValues),
      envOverride("SUPABASE_API_TLS_KEY_PATH", config.api.tls.key_path, projectEnvValues),
    );
  }
  // Go's `Config.Validate` rejects `api.port === 0`/`SUPABASE_API_PORT=0` ONLY
  // when `api.enabled` (`pkg/config/config.go:1006-1008`) — unlike `db.port`
  // below, which has no `enabled` gate. Resolved once into a named const so the
  // check and the URL derivation below share the same overridden value instead
  // of calling `envOverridePort` twice.
  const apiPort = envOverridePort(
    "SUPABASE_API_PORT",
    config.api.port,
    "api.port",
    projectEnvValues,
  );
  if (apiEnabled && apiPort === 0) {
    throw new Error("Missing required field in config: api.port");
  }
  const apiExternalUrl = legacyResolveApiExternalUrl(
    {
      external_url: envOverride(
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
  // Go's `Config.Validate` checks `db.major_version` right after `db.port`
  // (`pkg/config/config.go:1034-1061`), unconditionally (no `enabled` gate).
  const majorVersion = envOverrideMajorVersion(config.db.major_version, projectEnvValues);
  validateDbMajorVersion(majorVersion);
  // Go's `Config.Validate` rejects `studio.port === 0`/`SUPABASE_STUDIO_PORT=0`
  // ONLY when `studio.enabled` (`pkg/config/config.go:1070-1073`) — same
  // enabled-gated pattern as `api.port` above.
  const studioEnabled = legacyEnvOverrideBool(
    "SUPABASE_STUDIO_ENABLED",
    config.studio.enabled,
    "studio.enabled",
    projectEnvValues,
  );
  const studioPort = envOverridePort(
    "SUPABASE_STUDIO_PORT",
    config.studio.port,
    "studio.port",
    projectEnvValues,
  );
  if (studioEnabled && studioPort === 0) {
    throw new Error("Missing required field in config: studio.port");
  }
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
  const mailpitPort = envOverridePort(
    "SUPABASE_LOCAL_SMTP_PORT",
    config.local_smtp.port,
    "local_smtp.port",
    projectEnvValues,
  );
  if (mailpitEnabled && mailpitPort === 0) {
    throw new Error("Missing required field in config: local_smtp.port");
  }
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
  // Go's `Config.Validate` checks `auth.site_url` first inside `if c.Auth.Enabled`
  // (`pkg/config/config.go:1086-1090`), before the signing-keys read below —
  // `@supabase/config`'s schema only defaults `site_url` when the key is ABSENT
  // (`Schema.withDecodingDefaultKey`), so an explicit `site_url = ""` decodes as
  // `""` with no schema-level error, same gap as `db.port === 0` above.
  const siteUrl = envOverride("SUPABASE_AUTH_SITE_URL", config.auth.site_url, projectEnvValues);
  if (authEnabled && (siteUrl === undefined || siteUrl.length === 0)) {
    throw new Error("Missing required field in config: auth.site_url");
  }
  const signingKey =
    authEnabled && signingKeysPath !== undefined && signingKeysPath.length > 0
      ? loadFirstSigningKey(workdir, signingKeysPath)
      : undefined;
  // Go's `Config.Validate` checks `edge_runtime.deno_version` after the auth
  // block and the functions loop (`pkg/config/config.go:1158-1173`), and —
  // unlike `studio.port`/`local_smtp.port` above — unconditionally, with no
  // `edge_runtime.enabled` gate.
  const denoVersion = envOverrideDenoVersion(config.edge_runtime.deno_version, projectEnvValues);
  validateDenoVersion(denoVersion);

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
