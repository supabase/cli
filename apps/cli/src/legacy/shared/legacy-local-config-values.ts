import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { ENV_CAPTURE_REGEX, type ProjectConfig } from "@supabase/config";
import { defaultJwtSecret, defaultPublishableKey, defaultSecretKey } from "@supabase/stack/effect";
import { Schema } from "effect";

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
function envOverride(
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
 * `analytics.backend`-flavored sibling of {@link envOverridePort}/
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
    envOverride("SUPABASE_ANALYTICS_BACKEND", undefined, projectEnvValues) ?? configured;
  if (value !== "postgres" && value !== "bigquery") {
    throw new LegacyInvalidAnalyticsBackendEnvOverrideError("analytics.backend", value);
  }
  return value;
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
 * Applied AFTER {@link envOverride}, matching Go: an env-sourced override lands
 * on the same `config.Secret` field and goes through the same decode hook as a
 * TOML-sourced value, so `SUPABASE_AUTH_JWT_SECRET=encrypted:...` is decrypted
 * too, not just the config.toml value.
 */
function decryptAuthSecret(
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
  const absolutePath = legacyResolveSigningKeysPath(workdir, signingKeysPath);

  let contents: string;
  try {
    contents = readFileSync(absolutePath, "utf8");
  } catch (cause) {
    throw new LegacyConfigValidateError(legacySigningKeysReadErrorMessage(cause));
  }

  let jwks: ReadonlyArray<LegacyJwk>;
  try {
    jwks = decodeLegacyJwks(JSON.parse(contents));
  } catch (cause) {
    throw new LegacyConfigValidateError(legacySigningKeysDecodeErrorMessage(cause));
  }
  return jwks[0];
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
 * {@link loadFirstSigningKey}'s `signing_keys_path`, which Go does guard with `filepath.IsAbs`
 * (`config.go:928-929`). See `legacyResolveApiTlsPath`. Matches the identical Kong-side
 * validation already ported for `seed buckets`/`storage` in
 * `legacy-storage-credentials.ts`'s `validateLocalKongTls`.
 *
 * Uses `node:fs` directly for the same reason as {@link loadFirstSigningKey}: this stays a plain
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
 * Go's `(e *email) validate(fsys)` template/notification content read (`pkg/config/
 * config.go:1293-1313`), called from `Config.Validate` right after `Auth.MFA.validate()`, still
 * inside `if c.Auth.Enabled` (`config.go:1142`). Every template is checked unconditionally; a
 * notification only when that notification is itself enabled (`config.go:1308`). Uses the same
 * `readFileSync`-based pattern as {@link loadFirstSigningKey}/`readApiTlsFiles` in this file,
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
 * `auth.email.template.<name>.*`/`auth.email.notification.<name>.*` are Viper-bound like every
 * other nested field once `[auth.email.template.<name>]`/`[auth.email.notification.<name>]` are
 * present in config.toml (`ExperimentalBindStruct`/`AutomaticEnv`, `config.go:581-586`), so
 * `SUPABASE_AUTH_EMAIL_TEMPLATE_<NAME>_CONTENT_PATH`/`SUPABASE_AUTH_EMAIL_NOTIFICATION_<NAME>_
 * ENABLED`/`_CONTENT_PATH` overrides apply before this read runs. Unlike the hook/passkey/smtp
 * presence gates elsewhere in this file, no extra raw-document presence check is needed here to
 * decide WHETHER to apply an override: `email.template`/`email.notification` are `Schema.Record`s
 * (`packages/config/src/auth/email.ts`), which — unlike a fixed-shape struct with
 * `withDecodingDefaultKey` — only ever contain a key when the TOML section was actually present,
 * so `Object.entries` already reflects presence.
 */
function readAuthEmailTemplateContent(
  email: ProjectConfig["auth"]["email"],
  workdir: string,
  authDocument: Record<string, unknown> | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): void {
  const emailDoc = asRecord(authDocument?.["email"]);
  const templatesDoc = asRecord(emailDoc?.["template"]);
  const notificationsDoc = asRecord(emailDoc?.["notification"]);

  for (const [name, tmpl] of Object.entries(email.template)) {
    const contentPath =
      envOverride(
        `SUPABASE_AUTH_EMAIL_TEMPLATE_${name.toUpperCase()}_CONTENT_PATH`,
        tmpl.content_path,
        projectEnvValues,
      ) ?? tmpl.content_path;
    const path = legacyResolveEmailTemplateContentPath({
      section: "template",
      name,
      contentPath,
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
    const envPrefix = `SUPABASE_AUTH_EMAIL_NOTIFICATION_${name.toUpperCase()}`;
    const enabled = legacyEnvOverrideBool(
      `${envPrefix}_ENABLED`,
      tmpl.enabled,
      `auth.email.notification.${name}.enabled`,
      projectEnvValues,
    );
    if (!enabled) continue;
    const contentPath =
      envOverride(`${envPrefix}_CONTENT_PATH`, tmpl.content_path, projectEnvValues) ??
      tmpl.content_path;
    const path = legacyResolveEmailTemplateContentPath({
      section: "notification",
      name,
      contentPath,
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
 * `SUPABASE_DB_MAJOR_VERSION` sibling of {@link envOverridePort} for the one
 * numeric field Go decodes as `uint` rather than `uint16` (`pkg/config/db.go:87`)
 * — same generic Viper `AutomaticEnv` binding (`config.go:576-586`), same
 * mapstructure hard-fail-on-bad-value semantics as the port/bool overrides, but
 * with no upper-bound cap. A non-digit override folds into the same generic
 * "Invalid db.major_version" message `legacyValidateResolvedConfig` produces for
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
 * `SUPABASE_EDGE_RUNTIME_DENO_VERSION` sibling of {@link envOverrideMajorVersion}
 * — same generic Viper `AutomaticEnv` binding, same mapstructure
 * hard-fail-on-bad-value semantics, no upper-bound cap. A non-digit override
 * folds into the same generic "Invalid edge_runtime.deno_version" message
 * `legacyValidateResolvedConfig` produces for an out-of-set numeric value.
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

/** Go's `(s *sms) validate()` fixed provider priority (`pkg/config/config.go:1348-1410`) — a
 * `switch` that validates ONLY the first enabled provider in this order. */
const LEGACY_SMS_PROVIDER_ORDER = [
  "twilio",
  "twilio_verify",
  "messagebird",
  "textlocal",
  "vonage",
] as const;

/** Required fields per SMS provider, in the order Go checks them (`config.go:1349-1403`). */
const LEGACY_SMS_REQUIRED_FIELDS: Record<
  (typeof LEGACY_SMS_PROVIDER_ORDER)[number],
  ReadonlyArray<string>
> = {
  twilio: ["account_sid", "message_service_sid", "auth_token"],
  twilio_verify: ["account_sid", "message_service_sid", "auth_token"],
  messagebird: ["originator", "access_key"],
  textlocal: ["sender", "api_key"],
  vonage: ["from", "api_key", "api_secret"],
};

/**
 * Go's `(s *sms) validate()` (`pkg/config/config.go:1348-1410`): a boolean `switch` that inspects
 * providers in the FIXED priority order above and validates ONLY the first one whose `enabled` is
 * true — a later enabled-but-incomplete provider is never even looked at. `@supabase/config`'s
 * `sms` schema (`packages/config/src/auth/sms.ts`) already implements this exact switch for the
 * schema-decoded (pre-env-override) TOML value, which is Go-parity-correct for a config with no
 * relevant `SUPABASE_AUTH_SMS_*` env override — but `@supabase/config`'s decode pipeline never
 * resolves `SUPABASE_*` overrides at all (only this legacy-shell layer does, post-decode), so a
 * `SUPABASE_AUTH_SMS_<PROVIDER>_ENABLED` override that flips a section's enabled state after
 * decode is invisible to it. This re-runs the same switch against the RAW `authDocument` with
 * env overrides applied first — same document-based, post-override pattern as
 * {@link validateAuthExternalProviders} below, and the same "duplicate D's/the schema's check for
 * the env-override-aware L path" tradeoff already accepted for that function.
 *
 * `auth.sms.<provider>.*` is Viper-bound like every other nested field once
 * `[auth.sms.<provider>]` is present in config.toml (`ExperimentalBindStruct`/`AutomaticEnv`,
 * `config.go:581-586`), so `SUPABASE_AUTH_SMS_<PROVIDER>_ENABLED`/`_<FIELD>` overrides apply
 * before this validation runs, gated on the raw provider section already being present, matching
 * `AutomaticEnv` (which only intercepts keys already present in the merged config).
 */
function validateAuthSmsProviders(
  authDocument: Record<string, unknown> | undefined,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): void {
  const smsDoc = asRecord(authDocument?.["sms"]);
  if (smsDoc === undefined) return;
  for (const providerName of LEGACY_SMS_PROVIDER_ORDER) {
    const providerDoc = asRecord(smsDoc[providerName]);
    if (providerDoc === undefined) continue;
    const envPrefix = `SUPABASE_AUTH_SMS_${providerName.toUpperCase()}`;
    const enabled = legacyEnvOverrideBool(
      `${envPrefix}_ENABLED`,
      providerDoc["enabled"] === true,
      `auth.sms.${providerName}.enabled`,
      projectEnvValues,
    );
    if (!enabled) continue;
    for (const field of LEGACY_SMS_REQUIRED_FIELDS[providerName]) {
      const value = envOverride(
        `${envPrefix}_${field.toUpperCase()}`,
        typeof providerDoc[field] === "string" ? providerDoc[field] : undefined,
        projectEnvValues,
      );
      if (value === undefined || value.length === 0) {
        throw new LegacyConfigValidateError(
          `Missing required field in config: auth.sms.${providerName}.${field}`,
        );
      }
    }
    // Go's switch stops at the first enabled provider — later providers are never inspected.
    return;
  }
}

/** Go's `external.validate()` deprecated-provider skip (`config.go:1419-1423`) — `linkedin`/
 * `slack` are deleted (and warned on, if enabled) before the required-field loop runs, so they
 * are never validated here. Mirrors `legacy-db-config.toml-read.ts`'s identical "B5: external
 * providers" skip list. */
const DEPRECATED_EXTERNAL_PROVIDERS = new Set(["linkedin", "slack"]);

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
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): void {
  const external = asRecord(authDocument?.["external"]);
  if (external === undefined) return;
  for (const name of Object.keys(external)) {
    if (DEPRECATED_EXTERNAL_PROVIDERS.has(name)) continue;
    const provider = asRecord(external[name]);
    if (provider === undefined) continue;
    const envPrefix = `SUPABASE_AUTH_EXTERNAL_${name.toUpperCase()}`;
    const enabled = legacyEnvOverrideBool(
      `${envPrefix}_ENABLED`,
      provider["enabled"] === true,
      `auth.external.${name}.enabled`,
      projectEnvValues,
    );
    if (!enabled) continue;
    const clientId = envOverride(
      `${envPrefix}_CLIENT_ID`,
      typeof provider["client_id"] === "string" ? provider["client_id"] : undefined,
      projectEnvValues,
    );
    if (clientId === undefined || clientId.length === 0) {
      throw new LegacyConfigValidateError(
        `Missing required field in config: auth.external.${name}.client_id`,
      );
    }
    const secret = envOverride(
      `${envPrefix}_SECRET`,
      typeof provider["secret"] === "string" ? provider["secret"] : undefined,
      projectEnvValues,
    );
    if (name !== "apple" && name !== "google" && (secret === undefined || secret.length === 0)) {
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
 * @throws when `auth.signing_keys_path` is set but the file is missing, malformed,
 * or its first key uses an unsupported algorithm — see {@link loadFirstSigningKey}
 * and {@link legacyGenerateAsymmetricGoJwt}.
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
  // so the fallback belongs here, not as a third branch after `envOverride`.
  // `SUPABASE_PROJECT_ID` is checked via the same `envOverride` precedence
  // every other field here uses, since Viper's `AutomaticEnv` binds it too
  // (`config.go:529-535`) and it can turn an explicit-empty file value (or an
  // unsanitizable basename fallback) back into a valid override.
  const resolvedProjectId = envOverride(
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
  const apiTlsCertPath = envOverride(
    "SUPABASE_API_TLS_CERT_PATH",
    config.api.tls.cert_path,
    projectEnvValues,
  );
  const apiTlsKeyPath = envOverride(
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
  // of calling `envOverridePort` twice.
  const apiPort = envOverridePort(
    "SUPABASE_API_PORT",
    config.api.port,
    "api.port",
    projectEnvValues,
  );
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
  // path (`legacy-db-config.toml-read.ts:1380`).
  const dbPort = envOverridePort("SUPABASE_DB_PORT", config.db.port, "db.port", projectEnvValues);
  // Go's `Config.Validate` checks `db.major_version` right after `db.port`
  // (`pkg/config/config.go:1034-1061`), unconditionally (no `enabled` gate).
  const majorVersion = envOverrideMajorVersion(config.db.major_version, projectEnvValues);
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
  const studioPort = envOverridePort(
    "SUPABASE_STUDIO_PORT",
    config.studio.port,
    "studio.port",
    projectEnvValues,
  );
  // Go's `Config.Validate` parses `studio.api_url` with `net/url.Parse` right
  // after the port check, still inside `if c.Studio.Enabled`
  // (`pkg/config/config.go:1074-1078`). `config.studio.api_url` is a required
  // (defaulted) field, so `envOverride` can only return `undefined` here if
  // that default itself were somehow undefined — the `??` fallback just
  // satisfies that generic signature.
  const studioApiUrl =
    envOverride("SUPABASE_STUDIO_API_URL", config.studio.api_url, projectEnvValues) ??
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
  const mailpitPort = envOverridePort(
    "SUPABASE_LOCAL_SMTP_PORT",
    config.local_smtp.port,
    "local_smtp.port",
    projectEnvValues,
  );
  const jwtSecret = resolveJwtSecret(
    decryptAuthSecret(
      envOverride("SUPABASE_AUTH_JWT_SECRET", config.auth.jwt_secret, projectEnvValues),
      projectEnvValues,
    ),
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
  // `LoadedProjectConfig.document` (the raw, pre-schema-default TOML `config` was decoded from) —
  // hoisted here (rather than inside the `authEnabled` block below, where it used to live) because
  // the captcha presence check right below needs it too. `undefined` for callers that haven't
  // threaded `document` through yet, in which case presence-based checks are simply skipped.
  const authDocument = asRecord(document?.["auth"]);
  // Go's `Config.Validate` checks `auth.captcha` right after `auth.site_url`,
  // still inside `if c.Auth.Enabled` (`pkg/config/config.go:1099-1109`): an
  // enabled CAPTCHA section requires both `provider` and `secret`. `auth.captcha.*`
  // is Viper-bound like every other nested field once `[auth.captcha]` is present
  // in config.toml (`ExperimentalBindStruct`/`AutomaticEnv`, `config.go:581-586`),
  // so `SUPABASE_AUTH_CAPTCHA_ENABLED`/`_PROVIDER`/`_SECRET` overrides apply before
  // this validation runs. Unlike the flat `auth.site_url` field, `config.auth.captcha`
  // does NOT decode to `undefined` when `[auth.captcha]` is absent from config.toml —
  // `captcha.ts`'s own `withDecodingDefaultKey` fills in `{ enabled: false }` even
  // through the outer `Schema.optionalKey` wrapper (`packages/config/src/auth/index.ts`),
  // confirmed empirically; there is no schema-level presence signal here, unlike
  // `auth.passkey`/`auth.webauthn` below. So, like those, presence is read from the raw
  // `authDocument` instead — matching Go's `AutomaticEnv` (which only intercepts keys
  // already present in the merged config), an absent `[auth.captcha]` section never
  // picks up an env override alone.
  const captchaDoc = asRecord(authDocument?.["captcha"]);
  const captchaInput: LegacyCaptchaInput | undefined = config.auth.captcha
    ? {
        enabled:
          captchaDoc !== undefined
            ? legacyEnvOverrideBool(
                "SUPABASE_AUTH_CAPTCHA_ENABLED",
                config.auth.captcha.enabled ?? false,
                "auth.captcha.enabled",
                projectEnvValues,
              )
            : (config.auth.captcha.enabled ?? false),
        provider:
          captchaDoc !== undefined
            ? envOverride(
                "SUPABASE_AUTH_CAPTCHA_PROVIDER",
                config.auth.captcha.provider,
                projectEnvValues,
              )
            : config.auth.captcha.provider,
        secret:
          captchaDoc !== undefined
            ? envOverride(
                "SUPABASE_AUTH_CAPTCHA_SECRET",
                config.auth.captcha.secret,
                projectEnvValues,
              )
            : config.auth.captcha.secret,
      }
    : undefined;
  const signingKey =
    authEnabled && signingKeysPath !== undefined && signingKeysPath.length > 0
      ? loadFirstSigningKey(workdir, signingKeysPath)
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
            passkeyDoc["enabled"] === true,
            "auth.passkey.enabled",
            projectEnvValues,
          )
        : false;
    const rpId =
      webauthnDoc !== undefined
        ? envOverride(
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
        ? envOverride("SUPABASE_AUTH_WEBAUTHN_RP_ORIGINS", undefined, projectEnvValues)
        : undefined;
    const rpOrigins =
      rpOriginsOverride !== undefined
        ? rpOriginsOverride.split(",")
        : Array.isArray(webauthnDoc?.["rp_origins"])
          ? webauthnDoc["rp_origins"]
          : undefined;
    const passkey: LegacyPasskeyInput | undefined = passkeyEnabled
      ? { webauthnPresent: webauthnDoc !== undefined, rpId, rpOrigins }
      : undefined;

    // Go's `hook.validate()` fixed iteration order (`pkg/config/config.go:1453-1485`) — only
    // enabled hooks are forwarded, in that order. `auth.hook.<type>.*` is Viper-bound like every
    // other nested field (`ExperimentalBindStruct`/`AutomaticEnv`, `config.go:581-586`), so
    // `SUPABASE_AUTH_HOOK_<TYPE>_ENABLED`/`_URI`/`_SECRETS` overrides apply before this
    // validation runs. `@supabase/config`'s hook schema always decodes a `{ enabled: false }`
    // default per type regardless of file presence (`packages/config/src/auth/hooks.ts`'s
    // `withDecodingDefaultKey`), which erases the presence signal Go's `AutomaticEnv` needs (it
    // only intercepts keys already present in the merged config) — so, like the passkey/webauthn
    // overrides above, this reads the raw `[auth.hook.<type>]` document instead to gate the
    // override on the section actually being present.
    const hookDocument = asRecord(authDocument?.["hook"]);
    const hooks: Array<LegacyHookInput> = [];
    for (const hookType of LEGACY_HOOK_TYPE_ORDER) {
      const hook = config.auth.hook[hookType];
      const hookSectionPresent = asRecord(hookDocument?.[hookType]) !== undefined;
      const envPrefix = `SUPABASE_AUTH_HOOK_${hookType.toUpperCase()}`;
      const hookEnabled = hookSectionPresent
        ? legacyEnvOverrideBool(
            `${envPrefix}_ENABLED`,
            hook.enabled,
            `auth.hook.${hookType}.enabled`,
            projectEnvValues,
          )
        : hook.enabled;
      if (hookEnabled) {
        hooks.push({
          type: hookType,
          uri:
            (hookSectionPresent
              ? envOverride(`${envPrefix}_URI`, hook.uri, projectEnvValues)
              : hook.uri) ?? "",
          secrets:
            (hookSectionPresent
              ? envOverride(`${envPrefix}_SECRETS`, hook.secrets, projectEnvValues)
              : hook.secrets) ?? "",
        });
      }
    }

    // Go's `Auth.MFA` factor fields (`TOTP`/`Phone`/`WebAuthn`) are value-typed structs
    // (`pkg/config/auth.go:317-320`), never `nil` — unlike `Auth.Hook`'s pointer-typed fields
    // above, `ExperimentalBindStruct` always recurses into them (vendored Viper's
    // `decodeStructKeys`/`flattenAndMergeMap`) regardless of whether `[auth.mfa.<factor>]` is
    // present in config.toml (the default template even leaves `[auth.mfa.web_authn]` commented
    // out and it's still overridable), so `SUPABASE_AUTH_MFA_<FACTOR>_{ENROLL,VERIFY}_ENABLED`
    // overrides always apply before `Auth.MFA.validate()` runs (`config.go:1523-1534`) — no
    // raw-document presence gate needed here, unlike hooks/smtp above.
    const mfa: ReadonlyArray<LegacyMfaFactorInput> = [
      {
        label: "totp",
        enrollEnabled: legacyEnvOverrideBool(
          "SUPABASE_AUTH_MFA_TOTP_ENROLL_ENABLED",
          config.auth.mfa.totp.enroll_enabled,
          "auth.mfa.totp.enroll_enabled",
          projectEnvValues,
        ),
        verifyEnabled: legacyEnvOverrideBool(
          "SUPABASE_AUTH_MFA_TOTP_VERIFY_ENABLED",
          config.auth.mfa.totp.verify_enabled,
          "auth.mfa.totp.verify_enabled",
          projectEnvValues,
        ),
      },
      {
        label: "phone",
        enrollEnabled: legacyEnvOverrideBool(
          "SUPABASE_AUTH_MFA_PHONE_ENROLL_ENABLED",
          config.auth.mfa.phone.enroll_enabled,
          "auth.mfa.phone.enroll_enabled",
          projectEnvValues,
        ),
        verifyEnabled: legacyEnvOverrideBool(
          "SUPABASE_AUTH_MFA_PHONE_VERIFY_ENABLED",
          config.auth.mfa.phone.verify_enabled,
          "auth.mfa.phone.verify_enabled",
          projectEnvValues,
        ),
      },
      {
        label: "web_authn",
        enrollEnabled: legacyEnvOverrideBool(
          "SUPABASE_AUTH_MFA_WEB_AUTHN_ENROLL_ENABLED",
          config.auth.mfa.web_authn.enroll_enabled,
          "auth.mfa.web_authn.enroll_enabled",
          projectEnvValues,
        ),
        verifyEnabled: legacyEnvOverrideBool(
          "SUPABASE_AUTH_MFA_WEB_AUTHN_VERIFY_ENABLED",
          config.auth.mfa.web_authn.verify_enabled,
          "auth.mfa.web_authn.verify_enabled",
          projectEnvValues,
        ),
      },
    ];

    // Go's `Config.Validate` runs the email template/notification content read right after
    // `Auth.MFA.validate()`, still inside `if c.Auth.Enabled` (`config.go:1142`) — this I/O read
    // stays at this exact textual position (see this function's `@throws` doc for why).
    readAuthEmailTemplateContent(config.auth.email, workdir, authDocument, projectEnvValues);

    // Go's `[auth.email.smtp]` presence-based `enabled` default (`pkg/config/config.go:743-748`):
    // when the TOML table is present but omits `enabled`, Go treats it as `true` — a genuinely
    // presence-based default `@supabase/config`'s schema can't see (it always decodes
    // `smtp.enabled` to `false` when the key is absent), so this reads the raw `document` too.
    // `auth.email.smtp.*` is Viper-bound like every other nested field once `[auth.email.smtp]`
    // is present in config.toml (`ExperimentalBindStruct`/`AutomaticEnv`, `config.go:581-586`),
    // so `SUPABASE_AUTH_EMAIL_SMTP_ENABLED`/`_HOST`/`_PORT`/`_USER`/`_PASS`/`_ADMIN_EMAIL`
    // overrides apply before `Auth.Email.validate` runs (`config.go:1325-1344`) — layered on top
    // of the presence-aware raw-document read above, same `envOverride`/`envOverridePort`
    // precedent as every other field in this file.
    const smtpDoc = asRecord(asRecord(authDocument?.["email"])?.["smtp"]);
    const smtp: LegacySmtpInput | undefined =
      smtpDoc !== undefined
        ? {
            enabled: legacyEnvOverrideBool(
              "SUPABASE_AUTH_EMAIL_SMTP_ENABLED",
              smtpDoc["enabled"] === undefined ? true : smtpDoc["enabled"] === true,
              "auth.email.smtp.enabled",
              projectEnvValues,
            ),
            host:
              envOverride(
                "SUPABASE_AUTH_EMAIL_SMTP_HOST",
                typeof smtpDoc["host"] === "string" ? smtpDoc["host"] : "",
                projectEnvValues,
              ) ?? "",
            port: envOverridePort(
              "SUPABASE_AUTH_EMAIL_SMTP_PORT",
              typeof smtpDoc["port"] === "number" ? smtpDoc["port"] : 0,
              "auth.email.smtp.port",
              projectEnvValues,
            ),
            user:
              envOverride(
                "SUPABASE_AUTH_EMAIL_SMTP_USER",
                typeof smtpDoc["user"] === "string" ? smtpDoc["user"] : "",
                projectEnvValues,
              ) ?? "",
            pass:
              envOverride(
                "SUPABASE_AUTH_EMAIL_SMTP_PASS",
                typeof smtpDoc["pass"] === "string" ? smtpDoc["pass"] : "",
                projectEnvValues,
              ) ?? "",
            adminEmail:
              envOverride(
                "SUPABASE_AUTH_EMAIL_SMTP_ADMIN_EMAIL",
                typeof smtpDoc["admin_email"] === "string" ? smtpDoc["admin_email"] : "",
                projectEnvValues,
              ) ?? "",
          }
        : undefined;

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
          envOverride(
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
          envOverride(
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
          envOverride(
            "SUPABASE_AUTH_THIRD_PARTY_AWS_COGNITO_USER_POOL_ID",
            config.auth.third_party.aws_cognito.user_pool_id,
            projectEnvValues,
          ) ?? "",
        cognitoUserPoolRegion: envOverride(
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
          envOverride(
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
          envOverride(
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
  const denoVersion = envOverrideDenoVersion(config.edge_runtime.deno_version, projectEnvValues);

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
  const gcpProjectId = envOverride(
    "SUPABASE_ANALYTICS_GCP_PROJECT_ID",
    config.analytics.gcp_project_id,
    projectEnvValues,
  );
  const gcpProjectNumber = envOverride(
    "SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER",
    config.analytics.gcp_project_number,
    projectEnvValues,
  );
  const gcpJwtPath = envOverride(
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
    validateAuthSmsProviders(authDocument, projectEnvValues);
    validateAuthExternalProviders(authDocument, projectEnvValues);
  }

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
      decryptAuthSecret(
        envOverride("SUPABASE_AUTH_PUBLISHABLE_KEY", config.auth.publishable_key, projectEnvValues),
        projectEnvValues,
      ),
      defaultPublishableKey,
    ),
    secretKey: resolveOpaqueKey(
      decryptAuthSecret(
        envOverride("SUPABASE_AUTH_SECRET_KEY", config.auth.secret_key, projectEnvValues),
        projectEnvValues,
      ),
      defaultSecretKey,
    ),
    jwtSecret,
    anonKey: resolveSignedKey(
      decryptAuthSecret(
        envOverride("SUPABASE_AUTH_ANON_KEY", config.auth.anon_key, projectEnvValues),
        projectEnvValues,
      ),
      jwtSecret,
      signingKey,
      "anon",
    ),
    serviceRoleKey: resolveSignedKey(
      decryptAuthSecret(
        envOverride(
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
  };
}
