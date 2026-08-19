import { Effect, type FileSystem, Option, type Path } from "effect";
import * as SmolToml from "smol-toml";
import {
  LEGACY_PROJECT_REF_PATTERN,
  type LegacyAnalyticsInput,
  type LegacyAuthInput,
  type LegacyCaptchaInput,
  type LegacyConfigValidationInput,
  type LegacyDbInput,
  legacyEmailContentPathReadErrorMessage,
  type LegacyExperimentalInput,
  type LegacyHookInput,
  type LegacyMfaFactorInput,
  legacyParseGoBool,
  type LegacyPasskeyInput,
  legacyResolveEmailTemplateContentPath,
  legacyResolveSigningKeysPath,
  legacySigningKeysDecodeErrorMessage,
  legacySigningKeysReadErrorMessage,
  type LegacySmtpInput,
  type LegacyThirdPartyInput,
  legacyValidateResolvedConfig,
} from "./legacy-config-validate.ts";
import { LegacyDbConfigLoadError } from "./legacy-db-config.errors.ts";
import { parseDotEnv } from "./legacy-dotenv.ts";
import { legacyStrToArr } from "./legacy-local-config-values.ts";
import { ramInBytes } from "./legacy-size-units.ts";
import {
  legacyCollectDotenvPrivateKeys,
  legacyDecryptSecret,
  legacyIsEncryptedSecret,
} from "./legacy-vault-decrypt.ts";

/** Resolves a config `env(VAR)` reference: shell env first, then project `.env`. */
type EnvLookup = (name: string) => string | undefined;

/**
 * Subset of `supabase/config.toml` (plus the linked pooler URL) the db-config
 * resolver needs.
 *
 * A **missing** config file yields the default config values, but a
 * **malformed** file is a hard error (aborts the command rather than running
 * against the default local database).
 */
export interface LegacyDbTomlValues {
  readonly projectEnv: Readonly<Record<string, string>>;
  /**
   * Resolves a `SUPABASE_*` env var with Go's precedence: shell env (non-empty)
   * wins, then the loaded project `.env*` files (non-empty), else undefined.
   * Go writes project `.env` into the process env before viper's `AutomaticEnv`
   * reads these, so handlers must consult both
   * rather than `process.env` alone (e.g. `SUPABASE_EXPERIMENTAL_PG_DELTA`).
   */
  readonly envLookup: (name: string) => string | undefined;
  readonly apiSchemas: ReadonlyArray<string>;
  /** `[db] port`, default 54322 (`packages/config/src/db.ts`). */
  readonly port: number;
  /** `[db] shadow_port`, default 54320. */
  readonly shadowPort: number;
  /** `[db] password`, runtime default `"postgres"` (not in the config schema). */
  readonly password: string;
  /**
   * Linked connection pooler URL, used by the `--linked` pooler fallback. Written
   * by `supabase link` to `supabase/.temp/pooler-url`, not stored in config.toml
   * (the field is excluded from the config schema; it's populated
   * programmatically after config load).
   */
  readonly poolerConnectionString: Option.Option<string>;
  /** top-level `project_id`, used to name the local docker network. */
  readonly projectId: Option.Option<string>;
  /** `[db] major_version`, default 17. */
  readonly majorVersion: number;
  /**
   * `[experimental] orioledb_version` (env-expanded). When set on a 15/17 project,
   * `config.Validate` rewrites the Postgres image to the OrioleDB tag;
   * `None` for a vanilla project.
   */
  readonly orioledbVersion: Option.Option<string>;
  /**
   * `[edge_runtime] deno_version`, default 2. Selects the edge-runtime image tag:
   * `1` → the `deno1` image, otherwise the default.
   */
  readonly denoVersion: number;
  /**
   * `[experimental.pgdelta]` config, consumed by the declarative-schema commands
   * (`db schema declarative generate` / `sync`). Mirrors `PgDeltaConfig`.
   */
  readonly pgDelta: LegacyPgDeltaTomlConfig;
  /** Effective `[experimental.webhooks].enabled`; false when the section is absent. */
  readonly webhooksEnabled: boolean;
  /**
   * The subset of config that shapes the shadow-database platform baseline and
   * therefore the declarative catalog-cache key (`setupInputsToken`). Drift in
   * any of these must self-invalidate cached catalogs.
   */
  readonly baseline: LegacyBaselineTomlConfig;
  /** `[db.migrations] enabled` (default true) — gates `up`/`down` migration apply. */
  readonly migrationsEnabled: boolean;
  /**
   * `[db.migrations] schema_paths`, default `[]` — resolved (supabase-prefixed when
   * relative, `path.Join`/`path.Clean`) and `SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS`
   * env-overridable exactly like `seed.sqlPaths` below, resolved unconditionally (not
   * gated on `db.migrations.enabled`). Feeds `apply.MigrateAndSeed`'s EXPERIMENTAL
   * declarative branch (`legacyApplySchemaFiles`) — consumed by `legacyMigrateAndSeed`
   * (`start`'s fresh-volume setup, `migration down`) and by `db reset`'s own
   * `--experimental` remote path.
   */
  readonly schemaPaths: ReadonlyArray<string>;
  /**
   * `[db.migrations] schema_paths`, RAW patterns — the SAME env/remote-override
   * resolution as {@link schemaPaths} above (`SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS`,
   * remote-override tiering), but WITHOUT the `supabase/`-prefix + `path.Join`/`path.Clean`
   * step — `utils.Config.Db.Migrations.SchemaPaths` pre-that-
   * resolution form. `legacyPrepareShadowSource`'s `schemaPaths` input (`db diff`/`db pull`'s
   * shadow-provisioning prelude) does that join itself (`legacyResolveSeedSqlPath`), so it
   * needs THIS raw form — passing {@link schemaPaths} there would double-join a relative
   * pattern (`supabase/supabase/...`). The `@supabase/config`-backed
   * `context.config.db.migrations.schema_paths` these two callers used before is a DIFFERENT
   * raw form: correct patterns, but never `SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS`-overridden
   * (`@supabase/config` has no viper-`AutomaticEnv` equivalent) — review: PRRT_kwDOErm0O86XDr4S.
   */
  readonly schemaPathPatterns: ReadonlyArray<string>;
  /** `[db.seed]` enabled + supabase-prefixed `sql_paths` globs — used by `down`. */
  readonly seed: LegacyDbSeedTomlConfig;
  /** `[db.vault]` secrets (name → resolved value) — upserted by `up`/`down`. */
  readonly vault: ReadonlyArray<LegacyDbVaultSecretToml>;
  /**
   * The matched `[remotes.<name>]` block name when a linked ref merged its override
   * (`Loading config override: [remotes.<name>]` line), else `undefined`.
   */
  readonly appliedRemote: string | undefined;
  /**
   * The config keys the matched remote block contributed at viper's OVERRIDE tier — see
   * {@link LegacyRemoteOverride.remoteOverrideKeys}'s own doc comment for the full
   * precedence rationale. Exposed here (in addition to being used internally, above) so a
   * caller resolving a SEPARATE config read for the same linked ref — `legacyBuildLocalDbContainerInputs`,
   * whose `@supabase/config`-backed loader merges the same remote block's VALUES but
   * tracks none of which keys it set — can preserve the identical remote-over-env
   * precedence for the shadow's own bootstrap fields (`db diff --linked`/`db pull`,
   * CLI-1956), without re-deriving this set a third time. Empty when no remote matched.
   */
  readonly remoteOverrideKeys: ReadonlySet<string>;
}

/** `[db.seed]` config surfaced for `migration down`'s seed step. */
interface LegacyDbSeedTomlConfig {
  readonly enabled: boolean;
  /** Glob patterns, each supabase-prefixed when relative (`config.resolve`). */
  readonly sqlPaths: ReadonlyArray<string>;
}

/**
 * A `[db.vault]` secret. `value` is the resolved plaintext: env-expanded and, for
 * a dotenvx `encrypted:` ciphertext, decrypted. `resolved` mirrors Go's
 * `len(SHA256) > 0` gate (true once the value resolved to a non-empty, non-`env(...)`
 * string — including a successful decrypt). The HMAC itself is not reproduced;
 * `UpsertVaultSecrets` only uses it as a resolved/unresolved flag, and `resolved`
 * stands in for it.
 */
interface LegacyDbVaultSecretToml {
  readonly name: string;
  readonly value: string;
  readonly resolved: boolean;
}

/**
 * Cache-key inputs from `[auth]`/`[storage]`/`[realtime]`/`[api]`/`[db.vault]`.
 * Exported so callers that build this cache-key subset directly (e.g.
 * `legacyResolveSetupInputs` in `legacy-pgdelta.cache.ts`) reference this shape
 * instead of re-declaring it inline, making field drift a compile error rather
 * than a silent cache-key gap.
 */
export interface LegacyBaselineTomlConfig {
  /** `[auth] enabled`, default true. Gates `initSchema`'s auth service migration. */
  readonly authEnabled: boolean;
  /** `[storage] enabled`, default true. */
  readonly storageEnabled: boolean;
  /** `[realtime] enabled`, default true. */
  readonly realtimeEnabled: boolean;
  /**
   * `[api] auto_expose_new_tables` (tri-state `*bool`). `None` when unset. Drives
   * `ApplyApiPrivileges`; the cache key folds in the *effective* bool (unset and
   * `false` both mean revoke-by-default since the 2026-05-30 flip).
   */
  readonly apiAutoExposeNewTables: Option.Option<boolean>;
  /** `[db.vault]` secret names (sorted), created during setup by `UpsertVaultSecrets`. */
  readonly vaultNames: ReadonlyArray<string>;
}

/**
 * The `[experimental.pgdelta]` subtree. `npmVersion` is sourced from
 * `supabase/.temp/pgdelta-version` (not the TOML), matching `config.Load`.
 */
export interface LegacyPgDeltaTomlConfig {
  /** `[experimental.pgdelta] enabled`, default false. `IsPgDeltaEnabled`. */
  readonly enabled: boolean;
  /**
   * `[experimental.pgdelta] declarative_schema_path`, resolved to a
   * `supabase/`-prefixed path when relative. `None` → callers use the default
   * `supabase/schemas` (`legacyResolveDeclarativeDir`).
   */
  readonly declarativeSchemaPath: Option.Option<string>;
  /** `[experimental.pgdelta] format_options`, a JSON string passed to pg-delta. */
  readonly formatOptions: Option.Option<string>;
  /** `@supabase/pg-delta` npm version from `.temp/pgdelta-version`. */
  readonly npmVersion: Option.Option<string>;
}

const DEFAULT_PORT = 54322;
const DEFAULT_SHADOW_PORT = 54320;
const DEFAULT_MAJOR_VERSION = 17;
const DEFAULT_PASSWORD = "postgres";
const DEFAULT_API_SCHEMAS = ["public", "graphql_public"] as const;
/** `[edge_runtime] deno_version` default (`config.toml` template). 2 → the current edge-runtime image. */
const DEFAULT_DENO_VERSION = 2;

/** Default declarative schema dir. */
const DEFAULT_DECLARATIVE_DIR_SEGMENTS = ["supabase", "schemas"] as const;

type RawDoc = { readonly [key: string]: unknown };

function asRecord(value: unknown): RawDoc | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawDoc)
    : undefined;
}

/** Recursively merge `override` over `base` (nested tables merge, scalars/arrays
 * replace), per-key. */
function deepMergeDoc(base: RawDoc, override: RawDoc): RawDoc {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = out[key];
    const baseRecord = asRecord(baseValue);
    const overrideRecord = asRecord(value);
    out[key] =
      baseRecord !== undefined && overrideRecord !== undefined
        ? deepMergeDoc(baseRecord, overrideRecord)
        : value;
  }
  return out;
}

/**
 * Merge the `[remotes.<name>]` block whose `project_id` equals `ref` over the base
 * config. The block key name is only used for diagnostics; the match is on
 * `project_id`.
 */
interface LegacyRemoteOverride {
  readonly doc: RawDoc | undefined;
  /**
   * The name of the matched `[remotes.<name>]` block whose `project_id` equals the
   * resolved ref, or `undefined` when no block matched. Callers echo the
   * `Loading config override: [remotes.<name>]` stderr line from this.
   */
  readonly appliedRemote?: string;
  /**
   * The config keys the matched remote block contributed at override tier. Each
   * explicitly-set remote key — plus the forced `db.seed.enabled` default
   * injected when the block omits it — must outrank the matching `SUPABASE_*`
   * env override (a plain TOML value elsewhere is still env-overridable). Holds
   * every key in `LEGACY_ENV_OVERRIDABLE_KEYS` the matched block supplies, plus
   * `db.seed.enabled` (always).
   */
  readonly remoteOverrideKeys: ReadonlySet<string>;
}

/**
 * The `project_id` of a `[remotes.<name>]` block as used for block-matching and
 * duplicate detection: `SUPABASE_REMOTES_<NAME>_PROJECT_ID` wins when
 * non-empty; an empty env value is dropped (never overrides an empty shell
 * var), falling back to the RAW TOML literal — unexpanded, so a TOML `env(...)`
 * form is NOT resolved here. Validation reads the decoded (expanded) field
 * instead — see `legacyResolveValidatedRemoteProjectId`.
 */
function legacyResolveRemoteProjectId(
  name: string,
  block: RawDoc | undefined,
  lookup: EnvLookup,
): string | undefined {
  const fromEnv = lookup(`SUPABASE_REMOTES_${name.toUpperCase()}_PROJECT_ID`);
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const literal = block?.["project_id"];
  return typeof literal === "string" ? literal : undefined;
}

/**
 * The `project_id` of a `[remotes.<name>]` block as used for validation: the
 * decoded value, with `env(...)` already expanded (an unset `env(...)` stays
 * literal and fails the ref pattern). The `SUPABASE_REMOTES_<NAME>_PROJECT_ID`
 * env override still wins when non-empty, same precedence as the
 * block-matching lookup above.
 */
function legacyResolveValidatedRemoteProjectId(
  name: string,
  block: RawDoc | undefined,
  lookup: EnvLookup,
): string | undefined {
  const fromEnv = lookup(`SUPABASE_REMOTES_${name.toUpperCase()}_PROJECT_ID`);
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const literal = block?.["project_id"];
  return typeof literal === "string" ? legacyExpandEnv(literal, lookup) : undefined;
}

/**
 * Every dotted config key this reader resolves with a `SUPABASE_*` env override.
 * When a matched `[remotes.*]` block supplies any of these, the block value
 * must beat the matching env override.
 */
export const LEGACY_ENV_OVERRIDABLE_KEYS = [
  // The matched `[remotes.<name>]` block's own `project_id` field is what selected it in the
  // first place (`applyRemoteOverride` above matches on exactly this key) — same override-tier
  // reasoning as every other key in this array. NOT guaranteed present, though: a block can also
  // match purely via its `SUPABASE_REMOTES_<NAME>_PROJECT_ID` env override with no literal
  // `project_id` line in the block's own TOML table, in which case this reader's own
  // `legacyBlockProvidesKey` check below correctly finds the key absent from the block, so
  // `remoteOverrideKeys` omits it and the env override still applies for that (nonexistent)
  // literal key (review: PRRT_kwDOErm0O86XHGDL).
  "project_id",
  "api.schemas",
  "db.port",
  "db.shadow_port",
  "db.major_version",
  "db.migrations.enabled",
  "db.migrations.schema_paths",
  "db.seed.enabled",
  "db.seed.sql_paths",
  "auth.enabled",
  // Not read by THIS reader's own resolved fields (nor by `apiUrl`'s own `api.port`/
  // `api.tls.enabled`/`api.external_url` inputs, unlike those three) — tracked purely because
  // `legacyResolveLocalConfigValues`'s `legacyEnvOverrideBool("SUPABASE_API_ENABLED", ...)`
  // call THROWS on a malformed override, which would abort resolution of the caller-needed
  // fields it computes afterward (`apiPort`/`apiUrl`/`dbPort`/`rootKey`/etc.) — same
  // "throws before a value the caller needs is resolved" rationale as `auth.enabled` above and
  // `analytics.enabled`/`edge_runtime.deno_version` below (review: PRRT_kwDOErm0O86W5UlV).
  "api.enabled",
  "edge_runtime.deno_version",
  "experimental.webhooks.enabled",
  "experimental.pgdelta.enabled",
  "experimental.pgdelta.declarative_schema_path",
  "experimental.pgdelta.format_options",
  "api.auto_expose_new_tables",
  "analytics.enabled",
  "analytics.backend",
  "analytics.gcp_project_id",
  "analytics.gcp_project_number",
  "analytics.gcp_jwt_path",
  // Not read by THIS reader's own resolved fields — tracked so `remoteOverrideKeys` (exposed
  // on this module's return value, see its own doc comment) also covers every field
  // `legacyResolveDbBootstrapConfig`/`legacyResolveDbSettingsEnvOverrides`
  // (`legacy/shared/db-bootstrap/`) resolve for the shadow's own container spec on the
  // `db diff --linked`/`db pull` native-provisioning path (CLI-1956).
  "experimental.orioledb_version",
  "experimental.s3_host",
  "experimental.s3_region",
  "experimental.s3_access_key",
  "experimental.s3_secret_key",
  "realtime.enabled",
  "realtime.ip_version",
  "realtime.max_header_length",
  "storage.enabled",
  "storage.file_size_limit",
  "db.health_timeout",
  "db.settings.effective_cache_size",
  "db.settings.logical_decoding_work_mem",
  "db.settings.maintenance_work_mem",
  "db.settings.max_connections",
  "db.settings.max_locks_per_transaction",
  "db.settings.max_parallel_maintenance_workers",
  "db.settings.max_parallel_workers",
  "db.settings.max_parallel_workers_per_gather",
  "db.settings.max_replication_slots",
  "db.settings.max_slot_wal_keep_size",
  "db.settings.max_standby_archive_delay",
  "db.settings.max_standby_streaming_delay",
  "db.settings.max_wal_size",
  "db.settings.max_wal_senders",
  "db.settings.max_worker_processes",
  "db.settings.session_replication_role",
  "db.settings.shared_buffers",
  "db.settings.statement_timeout",
  "db.settings.track_activity_query_size",
  "db.settings.track_commit_timestamp",
  "db.settings.wal_keep_size",
  "db.settings.wal_sender_timeout",
  "db.settings.work_mem",
  "db.network_restrictions.enabled",
  // Not read by `legacyResolveDbBootstrapConfig`/`legacyResolveDbSettingsEnvOverrides` above —
  // these feed `legacyResolveLocalConfigValues`'s OWN fields instead (`apiUrl`/`dbUrl`/
  // `dbPort`/`rootKey`/`jwtSecret`/`authSiteUrl`/`authJwtExpiry`/`anonKey`/`serviceRoleKey`),
  // which the shadow's container spec/fresh-DB setup input also consume on the same
  // `db diff --linked`/`db pull` path (review: PRRT_kwDOErm0O86W2tRi) — same override-tier
  // gap as the block above, just for that resolver's reachable subset instead of this one's.
  "db.root_key",
  "api.port",
  "api.tls.enabled",
  // Not read by `legacyResolveDbBootstrapConfig`/`legacyResolveDbSettingsEnvOverrides` above,
  // same as `api.tls.enabled`/`api.port` — these feed `legacyResolveLocalConfigValues`'s own
  // `readApiTlsFiles` gate (`apiEnabled && apiTlsEnabled`), which the shadow's own
  // `db diff --linked`/`db pull` setup input also consumes on the same path. Without this,
  // a matched remote's override-tier `api.tls.cert_path`/`key_path` could still lose to a
  // stale/missing ambient `SUPABASE_API_TLS_CERT_PATH`/`SUPABASE_API_TLS_KEY_PATH` (review:
  // PRRT_kwDOErm0O86W8ZYk).
  "api.tls.cert_path",
  "api.tls.key_path",
  "api.external_url",
  "auth.jwt_secret",
  "auth.jwt_expiry",
  "auth.site_url",
  "auth.anon_key",
  "auth.service_role_key",
  // Not read by ANY of the resolvers above — these feed `legacyResolveLocalJwks`'s/
  // `legacyResolveAuthExternalUrl`'s/`legacyResolveConfiguredSigningKeys`'s own fields
  // instead, which the shadow's PG15+ one-shot auth-migration job also consumes on the
  // same `db diff --linked`/`db pull` path (review: PRRT_kwDOErm0O86W3Ox_) — same
  // override-tier gap as the two blocks above, just for THOSE resolvers' reachable subset.
  "auth.signing_keys_path",
  "auth.external_url",
  "auth.third_party.firebase.enabled",
  "auth.third_party.firebase.project_id",
  "auth.third_party.auth0.enabled",
  "auth.third_party.auth0.tenant",
  "auth.third_party.auth0.tenant_region",
  "auth.third_party.aws_cognito.enabled",
  "auth.third_party.aws_cognito.user_pool_id",
  "auth.third_party.aws_cognito.user_pool_region",
  "auth.third_party.clerk.enabled",
  "auth.third_party.clerk.domain",
  "auth.third_party.workos.enabled",
  "auth.third_party.workos.issuer_url",
  // `auth.jwt_issuer`/`auth.additional_redirect_urls` are plain, non-throwing
  // `legacyEnvOverride`/comma-split string reads in `legacyResolveLocalConfigValues` — same
  // "non-throwing read is still a precedence bug" reasoning as `auth.external.*`'s
  // `client_id`/`url`/`redirect_uri` above: a matched remote's own value must beat a stale
  // ambient `SUPABASE_AUTH_JWT_ISSUER`/`SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS`.
  "auth.jwt_issuer",
  "auth.additional_redirect_urls",
  // Same "throws before a value the caller needs is resolved" bug class as `api.enabled`/
  // `auth.enabled`/`analytics.*`/`edge_runtime.deno_version` above, just for a much larger set of
  // fields the doc comment on `legacyResolveLocalConfigValues`'s `remoteOverrideKeys` parameter
  // used to claim were safe to leave ungated. That claim rested on "their own `legacyEnvOverride*`
  // calls cannot throw before a value the caller needs has already been resolved" — which doesn't
  // actually hold: `legacyResolveLocalConfigValues` is a single synchronous function that either
  // returns its whole object or throws, so ANY unconditional throw anywhere in its body (not just
  // ones textually positioned before a caller-needed field) aborts the entire call and denies the
  // shadow every field, including the ones already computed as local variables earlier in the
  // function. Every dotted key below resolves through `legacyEnvOverrideBool`/`legacyEnvOverrideUint`/
  // `legacyEnvOverrideAuthPasswordRequirements`, all of which throw on a malformed override — same
  // as `api.enabled`'s own reasoning, just generalized (review: PRRT_kwDOErm0O86W6R-G).
  "studio.enabled",
  "studio.port",
  "local_smtp.enabled",
  "local_smtp.port",
  "auth.enable_signup",
  "auth.enable_anonymous_sign_ins",
  "auth.enable_refresh_token_rotation",
  "auth.refresh_token_reuse_interval",
  "auth.enable_manual_linking",
  "auth.minimum_password_length",
  "auth.password_requirements",
  "auth.passkey.enabled",
  // `auth.webauthn.rp_id`/`.rp_origins` are the same shape of plain, non-throwing string/slice
  // reads `legacyResolveLocalConfigValues` resolves for its `passkey` validation input — same
  // "non-throwing read is still a precedence bug" reasoning as `auth.jwt_issuer` above.
  "auth.webauthn.rp_id",
  "auth.webauthn.rp_origins",
  "auth.hook.mfa_verification_attempt.enabled",
  "auth.hook.mfa_verification_attempt.uri",
  "auth.hook.mfa_verification_attempt.secrets",
  "auth.hook.password_verification_attempt.enabled",
  "auth.hook.password_verification_attempt.uri",
  "auth.hook.password_verification_attempt.secrets",
  "auth.hook.custom_access_token.enabled",
  "auth.hook.custom_access_token.uri",
  "auth.hook.custom_access_token.secrets",
  "auth.hook.send_sms.enabled",
  "auth.hook.send_sms.uri",
  "auth.hook.send_sms.secrets",
  "auth.hook.send_email.enabled",
  "auth.hook.send_email.uri",
  "auth.hook.send_email.secrets",
  "auth.hook.before_user_created.enabled",
  "auth.hook.before_user_created.uri",
  "auth.hook.before_user_created.secrets",
  "auth.mfa.totp.enroll_enabled",
  "auth.mfa.totp.verify_enabled",
  "auth.mfa.phone.enroll_enabled",
  "auth.mfa.phone.verify_enabled",
  "auth.mfa.phone.otp_length",
  "auth.mfa.web_authn.enroll_enabled",
  "auth.mfa.web_authn.verify_enabled",
  "auth.mfa.max_enrolled_factors",
  // `auth.mfa.phone.template`/`.max_frequency` are plain, non-throwing `legacyEnvOverride` string
  // reads in `legacyResolveAuthMfa` — same "non-throwing read is still a precedence bug"
  // reasoning as `auth.jwt_issuer`/`auth.webauthn.rp_id` above.
  "auth.mfa.phone.template",
  "auth.mfa.phone.max_frequency",
  "auth.captcha.enabled",
  // `auth.captcha.provider` can't throw on its own (`legacyEnvOverride` is a plain string read),
  // but `legacyValidateResolvedConfig`'s enum check (`legacy-config-validate.ts`) rejects any
  // value other than `hcaptcha`/`turnstile` — same "non-throwing read, throwing downstream
  // consumer" class as `studio.api_url` below. A matched remote's own valid `provider` must beat
  // a stale/unsupported ambient `SUPABASE_AUTH_CAPTCHA_PROVIDER`, or
  // `legacyValidateResolvedConfig` aborts the whole synchronous `legacyResolveLocalConfigValues`
  // call (and the shadow it feeds) on a value the override tier (above the ambient env tier)
  // never lets win.
  "auth.captcha.provider",
  // `auth.captcha.secret` is a `config.Secret`, decrypted the same
  // way `auth.email.smtp.pass` below is — `legacyResolveAuthCaptcha`'s ungated `legacyEnvOverride`
  // call let a malformed ambient `SUPABASE_AUTH_CAPTCHA_SECRET` outrank a matched remote's own
  // valid `secret` and throw during decryption, aborting the whole synchronous
  // `legacyResolveLocalConfigValues` call (and the shadow it feeds) on a value `v.Set`
  // (override tier, above `AutomaticEnv`) silently ignores — same bug class as `.pass` below
  // (review: PRRT_kwDOErm0O86XJ4HR).
  "auth.captcha.secret",
  "auth.email.smtp.enabled",
  "auth.email.smtp.port",
  // `auth.email.smtp.pass` is a `config.Secret`, decrypted uniformly
  // by `DecryptSecretHookFunc` decode hook regardless of which viper tier supplied the
  // raw value — so when a matched remote block sets it, `v.Set` (override tier) wins over
  // `AutomaticEnv` and the decode hook decrypts the REMOTE's value; an ambient malformed
  // `SUPABASE_AUTH_EMAIL_SMTP_PASS` never reaches decryption at all. `legacyResolveAuthEmailSmtp`
  // previously ran `legacyEnvOverride` unconditionally before decrypting, so that same malformed
  // env value could win over a matched remote's valid `pass` and throw, aborting the whole
  // synchronous `legacyResolveLocalConfigValues` call — same bug class as `.enabled`/`.port`
  // above, just for this Secret-typed leaf (review: PRRT_kwDOErm0O86XJYol).
  "auth.email.smtp.pass",
  // `auth.email.smtp.host`/`.user`/`.admin_email`/`.sender_name` are plain, non-throwing
  // `legacyEnvOverride` string reads in `legacyResolveAuthEmailSmtp` — unlike `.enabled`/`.port`/
  // `.pass` above, none of these can throw, but leaving them ungated is still a precedence bug,
  // same reasoning as `auth.email.template.*`'s `subject`/`content` below.
  "auth.email.smtp.host",
  "auth.email.smtp.user",
  "auth.email.smtp.admin_email",
  "auth.email.smtp.sender_name",
  // Not read by THIS reader's own resolved fields — tracked so `legacyResolveAuthEmail`
  // (`legacy-local-config-values.ts`) also gates its own throw-capable
  // `legacyEnvOverrideBool`/`legacyEnvOverrideUint` calls for these `auth.email.*` scalars,
  // same "throws before a value the caller needs is resolved" bug class as
  // `auth.email.smtp.enabled`/`.port` above (review: PRRT_kwDOErm0O86XHvYh).
  "auth.email.enable_signup",
  "auth.email.double_confirm_changes",
  "auth.email.enable_confirmations",
  "auth.email.secure_password_change",
  "auth.email.otp_length",
  "auth.email.otp_expiry",
  // `auth.email.max_frequency` is a plain, non-throwing `legacyEnvOverride` string read in
  // `legacyResolveAuthEmail` — same "non-throwing read is still a precedence bug" reasoning as
  // `auth.email.smtp.host` above.
  "auth.email.max_frequency",
  // `auth.sms.*` (`legacyResolveAuthSms`) has the identical "throws before a value the caller
  // needs is resolved" bug class as every other group above: `enable_signup`/`enable_confirmations`
  // and each provider's `enabled` run an UNGATED `legacyEnvOverrideBool`, and each provider's
  // Secret-typed field (`auth_token`/`access_key`/`api_key`/`api_secret`) runs an UNGATED
  // `legacyDecryptAuthSecret` — either can throw on a malformed
  // ambient `SUPABASE_AUTH_SMS_*` override even when a matched remote block already set that field
  // at viper's OVERRIDE tier, aborting the whole `legacyResolveLocalConfigValues` call (and the
  // shadow it feeds via `legacyBuildLocalDbContainerInputs`) — reachable via `validateAuthSmsProviders`,
  // called unconditionally whenever `authEnabled` (review: PRRT_kwDOErm0O86XFmjZ — the prior
  // "unreachable from the shadow path" rejection missed this call site).
  "auth.sms.enable_signup",
  "auth.sms.enable_confirmations",
  "auth.sms.twilio.enabled",
  "auth.sms.twilio.auth_token",
  "auth.sms.twilio_verify.enabled",
  "auth.sms.twilio_verify.auth_token",
  "auth.sms.messagebird.enabled",
  "auth.sms.messagebird.access_key",
  "auth.sms.textlocal.enabled",
  "auth.sms.textlocal.api_key",
  "auth.sms.vonage.enabled",
  "auth.sms.vonage.api_secret",
  // The remaining `auth.sms.<provider>.*` fields (`resolveField` in `legacyResolveAuthSms`) are
  // plain, non-throwing `legacyEnvOverride` string reads — `vonage.api_key` sitting right next to
  // the already-gated `vonage.api_secret` was the clearest tell that these were missed. Same
  // "non-throwing read is still a precedence bug" reasoning as `auth.email.smtp.host` above.
  "auth.sms.twilio.account_sid",
  "auth.sms.twilio.message_service_sid",
  "auth.sms.twilio_verify.account_sid",
  "auth.sms.twilio_verify.message_service_sid",
  "auth.sms.messagebird.originator",
  "auth.sms.textlocal.sender",
  "auth.sms.vonage.from",
  "auth.sms.vonage.api_key",
  // `auth.sms.template`/`.max_frequency` are the same shape, sibling to `auth.email.max_frequency`
  // above.
  "auth.sms.template",
  "auth.sms.max_frequency",
  // `auth.publishable_key`/`auth.secret_key` and
  // `studio.openai_api_key` are `config.Secret`-typed exactly like
  // `auth.email.smtp.pass`/`auth.captcha.secret` above, decrypted via the same throw-capable
  // `legacyDecryptAuthSecret` — but were never added to this allowlist when `anon_key`/
  // `service_role_key` (their sibling API-key pair, right next to them in
  // `legacyResolveLocalConfigValues`'s return block) were gated. Same bug class: an ungated
  // malformed ambient override can throw during decryption even when a matched remote block
  // already set the field, aborting the whole call.
  "auth.publishable_key",
  "auth.secret_key",
  "studio.openai_api_key",
  // `studio.api_url` is validated with `legacyGoUrlParse` inside `legacyValidateResolvedConfig`
  // (gated on `studio.enabled`, matching `studio.port` above) — a plain, non-throwing
  // `legacyEnvOverride` read here can still flip that downstream validate() outcome, same
  // "non-throwing read, throwing downstream consumer" class as the third_party required fields
  // above.
  "studio.api_url",
] as const;

/**
 * `auth.external.<name>` is a genuine map keyed by arbitrary provider name — not just the ~19
 * known ids `@supabase/config`'s schema recognizes, but any custom/unmodeled name a user's
 * `[auth.external.<name>]` table declares (`legacyResolveAuthExternalProviders`'s own doc
 * comment). A fixed `LEGACY_ENV_OVERRIDABLE_KEYS` entry per provider can't cover every possible
 * name a `[remotes.<ref>]` block might set, so these per-provider leaves are tracked dynamically
 * in {@link applyRemoteOverride} instead (flattening whichever provider names the matched block
 * actually supplies) rather than enumerated here.
 */
const LEGACY_AUTH_EXTERNAL_PROVIDER_FIELDS = [
  "enabled",
  "client_id",
  "secret",
  "url",
  "redirect_uri",
  "skip_nonce_check",
  "email_optional",
] as const;

/**
 * `auth.email.template.<name>`/`auth.email.notification.<name>` are the same shape of genuine,
 * arbitrarily-keyed map as `auth.external.<name>` above — a fixed `LEGACY_ENV_OVERRIDABLE_KEYS`
 * entry per template/notification name can't cover every name a `[remotes.<ref>]` block might
 * set, so these are also tracked dynamically in {@link applyRemoteOverride}. `content_path` is
 * the field that can actually abort resolution (a matched remote's own valid path losing to a
 * stale/missing ambient `_CONTENT_PATH` env var makes {@link legacyResolveAuthEmail}'s caller-side
 * file read throw — same "non-throwing read, throwing downstream consumer" class as
 * `auth.captcha.provider` above); `subject`/`content` can't throw the same way, but leaving them
 * ungated is still a precedence bug, same reasoning as `auth.external.*`'s `client_id`/`url`/
 * `redirect_uri` above (review: PRRT_kwDOErm0O86XLAYn, PRRT_kwDOErm0O86XLAYo).
 */
const LEGACY_AUTH_EMAIL_TEMPLATE_FIELDS = ["subject", "content_path", "content"] as const;

/** {@link LEGACY_AUTH_EMAIL_TEMPLATE_FIELDS}'s notification-section sibling — same fields, plus `enabled`. */
const LEGACY_AUTH_EMAIL_NOTIFICATION_FIELDS = [
  "enabled",
  "subject",
  "content_path",
  "content",
] as const;

/**
 * Every literal member of {@link LEGACY_ENV_OVERRIDABLE_KEYS}, PLUS the dotted-key patterns for
 * the three genuinely dynamically-keyed families {@link applyRemoteOverride} tracks separately —
 * arbitrary user-declared names (provider ids, email template/notification names), not a fixed
 * list, so they can't be enumerated as literal members (see
 * {@link LEGACY_AUTH_EXTERNAL_PROVIDER_FIELDS}/{@link LEGACY_AUTH_EMAIL_TEMPLATE_FIELDS}/
 * {@link LEGACY_AUTH_EMAIL_NOTIFICATION_FIELDS}'s own doc comments). Every
 * `remoteWins(...)`/`remoteOverrideKeys.has(...)` call site across this module,
 * `legacy-local-config-values.ts`, and `db-bootstrap/bootstrap-config.ts` is typed against this
 * union (via {@link legacyMakeRemoteWins}), so a typo'd dotted key is a compile error instead of a
 * silently-always-false gate.
 */
export type LegacyRemoteOverridableKey =
  | (typeof LEGACY_ENV_OVERRIDABLE_KEYS)[number]
  | `auth.external.${string}.${(typeof LEGACY_AUTH_EXTERNAL_PROVIDER_FIELDS)[number]}`
  | `auth.email.template.${string}.${(typeof LEGACY_AUTH_EMAIL_TEMPLATE_FIELDS)[number]}`
  | `auth.email.notification.${string}.${(typeof LEGACY_AUTH_EMAIL_NOTIFICATION_FIELDS)[number]}`;

/**
 * Hoists the `const remoteWins = (p: string): boolean => remoteOverrideKeys.has(p)` closure that
 * used to be copy-pasted once per remote-gated resolver (five times in
 * `legacy-local-config-values.ts`, once in `db-bootstrap/bootstrap-config.ts`) into a single
 * helper. The returned function's parameter is typed as {@link LegacyRemoteOverridableKey} —
 * narrower than `keys` itself, which stays the loosely-typed `ReadonlySet<string>` every resolver
 * already threads a `remoteOverrideKeys` parameter as — so every call site is checked against the
 * allowlist without having to also re-type every `remoteOverrideKeys` parameter/field across the
 * db-bootstrap/shadow-provisioning call graph (CLI-1956).
 */
export function legacyMakeRemoteWins(
  keys: ReadonlySet<string>,
): (key: LegacyRemoteOverridableKey) => boolean {
  return (key) => keys.has(key);
}

/** Whether `block` provides a value at the dotted `key` path (scalar, array, or sub-table). */
function legacyBlockProvidesKey(block: RawDoc, key: string): boolean {
  let current: unknown = block;
  for (const segment of key.split(".")) {
    const record = asRecord(current);
    if (record === undefined) return false;
    current = record[segment];
  }
  return current !== undefined;
}

function applyRemoteOverride(
  doc: RawDoc | undefined,
  ref: string,
  lookup: EnvLookup,
): LegacyRemoteOverride {
  const remotes = asRecord(doc?.["remotes"]);
  if (doc === undefined || remotes === undefined) return { doc, remoteOverrideKeys: new Set() };
  for (const name of Object.keys(remotes)) {
    const block = asRecord(remotes[name]);
    if (block === undefined) continue;
    // Match on the project_id from the raw lookup (env override > RAW TOML literal, no
    // `env(...)` expansion), so a block whose id comes from `SUPABASE_REMOTES_<NAME>_PROJECT_ID`
    // still merges while a TOML `env(...)` literal does not (blocks are selected before the
    // literal is expanded).
    if (legacyResolveRemoteProjectId(name, block, lookup) === ref) {
      const merged = deepMergeDoc(doc, block);
      const blockSeed = asRecord(asRecord(block["db"])?.["seed"]);
      // Flatten the WHOLE matched block and apply every leaf at override tier (above the ambient
      // env tier). Record every env-overridable key the block supplies — not just migrations/seed — so the
      // resolution below suppresses their `SUPABASE_*` value.
      const remoteOverrideKeys = new Set<string>();
      for (const key of LEGACY_ENV_OVERRIDABLE_KEYS) {
        if (legacyBlockProvidesKey(block, key)) remoteOverrideKeys.add(key);
      }
      // `auth.external.<name>` is a genuine map (arbitrary/custom provider names — see
      // `LEGACY_AUTH_EXTERNAL_PROVIDER_FIELDS`'s own doc comment), so flatten whichever provider
      // names/fields THIS matched block actually supplies instead of relying on a fixed list —
      // same per-leaf override-tier semantics as `LEGACY_ENV_OVERRIDABLE_KEYS` above, just
      // computed dynamically for this one dynamically-keyed section.
      const externalBlock = asRecord(asRecord(block["auth"])?.["external"]);
      if (externalBlock !== undefined) {
        for (const providerName of Object.keys(externalBlock)) {
          for (const field of LEGACY_AUTH_EXTERNAL_PROVIDER_FIELDS) {
            const key = `auth.external.${providerName}.${field}`;
            if (legacyBlockProvidesKey(block, key)) remoteOverrideKeys.add(key);
          }
        }
      }
      // `auth.email.template.<name>`/`auth.email.notification.<name>` are the same
      // arbitrarily-keyed shape as `auth.external.<name>` above — see
      // `LEGACY_AUTH_EMAIL_TEMPLATE_FIELDS`'s own doc comment.
      const emailBlock = asRecord(block["auth"])?.["email"];
      const emailTemplateBlock = asRecord(asRecord(emailBlock)?.["template"]);
      if (emailTemplateBlock !== undefined) {
        for (const templateName of Object.keys(emailTemplateBlock)) {
          for (const field of LEGACY_AUTH_EMAIL_TEMPLATE_FIELDS) {
            const key = `auth.email.template.${templateName}.${field}`;
            if (legacyBlockProvidesKey(block, key)) remoteOverrideKeys.add(key);
          }
        }
      }
      const emailNotificationBlock = asRecord(asRecord(emailBlock)?.["notification"]);
      if (emailNotificationBlock !== undefined) {
        for (const notificationName of Object.keys(emailNotificationBlock)) {
          for (const field of LEGACY_AUTH_EMAIL_NOTIFICATION_FIELDS) {
            const key = `auth.email.notification.${notificationName}.${field}`;
            if (legacyBlockProvidesKey(block, key)) remoteOverrideKeys.add(key);
          }
        }
      }
      // `db.seed.enabled` is ALWAYS override-tier for a matched block: either the block set
      // it, or `mergeRemoteConfig` forces it `false` when omitted —
      // so env never overrides it on a matched-remote linked run.
      remoteOverrideKeys.add("db.seed.enabled");
      if (blockSeed?.["enabled"] === undefined) {
        return {
          doc: deepMergeDoc(merged, { db: { seed: { enabled: false } } }),
          appliedRemote: name,
          remoteOverrideKeys,
        };
      }
      return { doc: merged, appliedRemote: name, remoteOverrideKeys };
    }
  }
  return { doc, remoteOverrideKeys: new Set() };
}

/**
 * `config.Load` aborts when two `[remotes.*]` blocks declare the same
 * `project_id`, regardless of which command runs.
 * Returns the conflicting pair (current + prior block name) or `undefined`.
 */
function findDuplicateRemoteProjectId(
  doc: RawDoc | undefined,
  lookup: EnvLookup,
): { readonly name: string; readonly other: string } | undefined {
  const remotes = asRecord(doc?.["remotes"]);
  if (remotes === undefined) return undefined;
  const seen = new Map<string, string>();
  for (const name of Object.keys(remotes)) {
    const block = asRecord(remotes[name]);
    // Dedupe on the project_id `v.GetString` returns (env override > RAW TOML literal,
    // no `env(...)` expansion), matching Go's duplicate check.
    const projectId = legacyResolveRemoteProjectId(name, block, lookup);
    if (projectId === undefined) continue;
    const prior = seen.get(projectId);
    if (prior !== undefined) return { name, other: prior };
    seen.set(projectId, name);
  }
  return undefined;
}

/**
 * `config.Validate` rejects any `[remotes.<name>]` whose `project_id` is not a
 * valid project ref, on every config load — so a malformed or
 * missing remote `project_id` fails even local/direct commands before touching the
 * database. Returns the first offending block name (object order) or `undefined`.
 */
function findInvalidRemoteProjectId(
  doc: RawDoc | undefined,
  lookup: EnvLookup,
): string | undefined {
  const remotes = asRecord(doc?.["remotes"]);
  if (remotes === undefined) return undefined;
  for (const name of Object.keys(remotes)) {
    const block = asRecord(remotes[name]);
    // Validate the DECODED project_id (env override > env-expanded TOML literal), matching
    // `Validate` over the decoded `remote.ProjectId` field, which
    // passed through `LoadEnvHook`. An unset `env(...)` stays literal and still fails Go's
    // ref pattern. (Block matching/dedup above use the RAW literal — `v.GetString`.)
    const projectId = legacyResolveValidatedRemoteProjectId(name, block, lookup);
    if (typeof projectId !== "string" || !LEGACY_PROJECT_REF_PATTERN.test(projectId)) {
      return name;
    }
  }
  return undefined;
}

const ENV_PATTERN = /^env\((.*)\)$/;

/**
 * Expand `env(VAR)` config form: a string matching `^env\((.*)\)$` resolves to
 * the named environment variable, but only when that variable is set and
 * non-empty; otherwise the literal value is preserved unchanged. `lookup`
 * resolves the name against the shell environment first and then the project
 * `.env` files.
 */
export function legacyExpandEnv(
  value: string,
  lookup: (name: string) => string | undefined,
): string {
  const matches = ENV_PATTERN.exec(value);
  if (matches !== null) {
    const env = lookup(matches[1] ?? "");
    if (env !== undefined && env.length > 0) return env;
  }
  return value;
}

/** `[db]` ports decode into `uint16`. */
const MAX_PORT = 65535;

/**
 * Resolve a `[db]` port field: the TOML value decodes into a `uint16`, and a
 * quoted `env(VAR)` reference is expanded first, then parsed as the port.
 * Resolution rules:
 *
 * - **Omitted** (`undefined`) → the schema default.
 * - **Present and resolves to a `uint16`** (a plain integer in range, or an
 * `env(VAR)` string that expands to one) → that value.
 * - **Present but cannot unmarshal** (non-numeric, negative, out of range, or an
 * unresolved `env(VAR)`) → `undefined`, signalling the caller to abort with
 * `LegacyDbConfigLoadError` rather than silently defaulting and running
 * against the default local database while hiding a broken config.
 */
function resolvePort(value: unknown, fallback: number, lookup: EnvLookup): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= MAX_PORT ? value : undefined;
  }
  if (typeof value === "string") {
    const expanded = legacyExpandEnv(value, lookup);
    if (/^\d+$/.test(expanded)) {
      const parsed = Number(expanded);
      if (parsed <= MAX_PORT) return parsed;
    }
  }
  return undefined;
}

/**
 * Resolve an optional integer config field (e.g. `db.major_version`): a
 * quoted `env(VAR)` reference is expanded, then the result decodes into a
 * `uint`, which strictly rejects a non-integer string like `17foo` rather
 * than truncating it. Returns the parsed integer, `"absent"` when the field
 * is omitted (caller uses the default), or `"invalid"` when present but not a
 * whole non-negative integer (caller fails the load rather than silently
 * defaulting and hiding a broken config).
 */
function resolveConfigInt(value: unknown, lookup: EnvLookup): number | "absent" | "invalid" {
  if (value === undefined) return "absent";
  if (typeof value === "number") return Number.isInteger(value) ? value : "invalid";
  if (typeof value === "string") {
    const expanded = legacyExpandEnv(value, lookup);
    if (/^\d+$/.test(expanded)) return Number(expanded);
  }
  return "invalid";
}

function resolveStringSlice(
  value: unknown,
  fallback: ReadonlyArray<string>,
  lookup: EnvLookup,
): ReadonlyArray<string> | undefined {
  if (value === undefined) return fallback;
  if (typeof value === "string") {
    const expanded = legacyExpandEnv(value, lookup);
    return expanded.length === 0 ? [] : expanded.split(",");
  }
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    return undefined;
  }
  return value.map((item) => legacyExpandEnv(item, lookup));
}

/**
 * Replicates `path.Join("supabase", pattern)` for a relative seed `sql_paths`
 * entry: `path.Clean` collapses `.`/`..` segments (`../seed.sql` → `seed.sql`,
 * `sub/../seed.sql` → `supabase/seed.sql`, `../../x.sql` → `../x.sql`). The
 * cleaned path is the `seed_files` hash key, so a non-collapsed key would miss
 * a previously recorded entry and re-run/re-record the seed. Forward-slash
 * only, not the platform `filepath.Join`.
 */
function legacyJoinSupabaseSeedPath(pattern: string): string {
  const out: Array<string> = [];
  for (const segment of `supabase/${pattern}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else {
      out.push(segment);
    }
  }
  return out.length === 0 ? "." : out.join("/");
}

/**
 * `filepath.IsAbs` on Windows (`internal/filepathlite/path_windows.go`'s
 * `IsAbs`/`volumeNameLen`) requires a volume name — a drive letter (`C:\`) or a UNC
 * prefix (`\\server\share`) — before a path counts as absolute; a bare leading
 * separator (`/schemas`, `\schemas`) has no volume name, so Go treats it as RELATIVE
 * and joins it under `supabase/`. `pathSvc.isAbsolute` is backed by `node:path`, which
 * selects `path.win32` on an actual Windows host, and Node's win32 `isAbsolute` treats
 * a bare leading separator as rooted at the *current drive* — i.e. absolute — so it
 * disagrees with Go on exactly this shape. Verified empirically: Node's
 * `path.win32.isAbsolute("/schemas/*.sql")` is `true`, while `filepath.IsAbs` on
 * the same input is `false` (`volumeNameLen` returns `0` — none of its drive-letter,
 * UNC, or device-path cases match a path with no volume component). Only the
 * seed/schema-paths resolve step below (`[db.seed].sql_paths`/
 * `[db.migrations].schema_paths`) needs this exact rule — real filesystem calls
 * elsewhere in this shell still need the platform's own `isAbsolute` to
 * resolve an actual path on disk.
 */
const legacyGoIsAbs = (pathSvc: Path.Path, pattern: string): boolean => {
  if (process.platform !== "win32") {
    return pathSvc.isAbsolute(pattern);
  }
  const isSeparator = (c: string | undefined): boolean => c === "/" || c === "\\";
  // Drive-letter volume (`C:\`, `c:/`): `volumeNameLen` accepts any byte before
  // `:` (case 2, `path[1] === ':'`), then `IsAbs` requires a separator right after.
  if (pattern.length >= 3 && pattern[1] === ":" && isSeparator(pattern[2])) {
    return true;
  }
  // UNC volume (`\\server\share`, `//server/share`): `IsAbs` treats a
  // double-separator-prefixed volume as absolute unconditionally.
  return pattern.length >= 2 && isSeparator(pattern[0]) && isSeparator(pattern[1]);
};

/**
 * Resolves a single seed/schema-paths entry: a relative pattern is joined
 * under `supabase/`; an absolute (or empty) pattern is returned verbatim.
 * Used by the reader for `[db.seed].sql_paths` and
 * `[db.migrations].schema_paths`, and by `db reset` for its `--sql-paths`
 * override — all three feed the glob the same resolved paths.
 */
export const legacyResolveSeedSqlPath = (pathSvc: Path.Path, pattern: string): string =>
  pattern.length === 0 || legacyGoIsAbs(pathSvc, pattern)
    ? pattern
    : legacyJoinSupabaseSeedPath(pattern);

/** `[db]` ports default through the development env unless `SUPABASE_ENV` overrides. */
const DEFAULT_SUPABASE_ENV = "development";

/**
 * Keys {@link legacyApplyProjectEnv} copies from the project `.env` into
 * `process.env`. Kept to an allowlist of values that are read *only* via
 * `process.env` (no project-env map path) and must reflect `supabase/.env`:
 * `SUPABASE_INTERNAL_IMAGE_REGISTRY` (`legacyGetRegistryImageUrl`) and
 * `PGDELTA_NPM_REGISTRY` (`legacyPgDeltaNpmRegistryOption`, read straight from
 * `process.env` for legacy-opt-out pg-delta edge-runtime invocations). The bundled
 * next implementation never consults it. Go's
 * `godotenv.Load` (`loadNestedEnv`) `os.Setenv`s every key from the project
 * `.env`, so both readers see a `.env`-only value there; omitting either here
 * would leave that one process.env-only reader blind to a project-`.env`-scoped
 * override the shell never set.
 * Everything else is read from {@link legacyLoadProjectEnv}'s returned map
 * (`envLookup`, `legacyResolveYesWithProjectEnv`, `resolveDbPassword`) or resolved
 * eagerly from the shell before any `.env` load — Go's root globals (workdir /
 * profile / `SUPABASE_ENV` / project-ref) are frozen before `loadNestedEnv`, so
 * writing them here would let our lazily-built resolvers diverge from Go (retarget
 * the project, switch the env-file set, or leak into the Go `--experimental` proxy).
 */
const LEGACY_PROCESS_ENV_APPLY_KEYS = [
  "SUPABASE_INTERNAL_IMAGE_REGISTRY",
  "PGDELTA_NPM_REGISTRY",
] as const;

/**
 * Load the project's nested `.env` files into a lookup map. **Pure**: it reads the
 * files and returns the merged map, with no `process.env` side effect — so the
 * `SUPABASE_YES` / `SUPABASE_DB_PASSWORD` readers that call it
 * (`legacyResolveYesWithProjectEnv`, `resolveDbPassword`) never mutate the global
 * environment. Commands that need an allowlisted key visible to a synchronous
 * `process.env` reader (`db dump` / `db pull` → `legacyGetRegistryImageUrl`) opt
 * into {@link legacyApplyProjectEnv} around the container work instead.
 *
 * Partially mirrors `loadNestedEnv` + `loadDefaultEnv`.
 * Go walks from the `supabase/` directory up to
 * the repo root and, in each directory, loads `.env.<env>.local`, `.env.local`
 * (skipped when `SUPABASE_ENV=test`), `.env.<env>`, then `.env` via `godotenv.Load`,
 * which never overrides a value already set. So the shell environment wins over the
 * files, the `supabase/` directory wins over the repo root, and earlier filenames
 * win within a directory. A malformed `.env` — or one that exists but cannot be
 * read — aborts: `loadEnvIfExists` swallows only `os.ErrNotExist` and returns
 * every other error. The path is named without leaking file contents (CWE-209-safe).
 */
export const legacyLoadProjectEnv = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
) {
  const env = process.env["SUPABASE_ENV"] || DEFAULT_SUPABASE_ENV;
  const filenames = [`.env.${env}.local`];
  if (env !== "test") filenames.push(".env.local");
  filenames.push(`.env.${env}`, ".env");
  // Go walks `supabase/` first, then the repo root; first writer wins.
  const dirs = [path.join(workdir, "supabase"), workdir];
  const loaded: Record<string, string> = {};
  for (const dir of dirs) {
    for (const name of filenames) {
      // Go's loadEnvIfExists ignores only os.ErrNotExist; any other read error
      // aborts rather than silently skipping the file (which would hide a broken
      // env-backed config). Effect surfaces "not found" as a NotFound PlatformError.
      const content = yield* fs.readFileString(path.join(dir, name)).pipe(
        Effect.map(Option.some<string>),
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new LegacyDbConfigLoadError({
                  message: `failed to read environment file: ${name}`,
                }),
              ),
        ),
      );
      if (Option.isNone(content)) continue;
      let parsed: Record<string, string>;
      try {
        parsed = parseDotEnv(content.value);
      } catch {
        return yield* Effect.fail(
          new LegacyDbConfigLoadError({ message: `failed to parse environment file: ${name}` }),
        );
      }
      for (const [key, value] of Object.entries(parsed)) {
        // godotenv.Load never overrides: the shell env and earlier files win.
        if (process.env[key] === undefined && loaded[key] === undefined) loaded[key] = value;
      }
    }
  }
  return loaded;
});

/**
 * Apply the allowlisted project-`.env` keys (see {@link LEGACY_PROCESS_ENV_APPLY_KEYS})
 * to `process.env` **for the duration of the current scope**, then revert. This is
 * the opt-in counterpart to the pure {@link legacyLoadProjectEnv}: `bootstrap` /
 * `db push` / `db pull` / `db dump` run it around their pg_dump / migration / pg-delta
 * container work so a `SUPABASE_INTERNAL_IMAGE_REGISTRY` or `PGDELTA_NPM_REGISTRY` set
 * only in `supabase/.env` still reaches `legacyGetRegistryImageUrl` /
 * `legacyPgDeltaNpmRegistryOption` (both read `process.env` synchronously) — mirroring
 * the `os.Setenv` half of `loadNestedEnv`. Kept out of the shared loader so
 * SUPABASE_YES / db-password reads stay side-effect-free.
 *
 * Never overrides an existing `process.env` value (`godotenv.Load` never
 * overrides; `loaded` already excludes keys present in `process.env`, and this
 * re-checks). The `acquireRelease` finalizer deletes only the keys it set when the
 * scope closes, so in-process test workers don't leak env between cases.
 */
export const legacyApplyProjectEnv = (
  loaded: Readonly<Record<string, string>>,
  keys: ReadonlyArray<string> = LEGACY_PROCESS_ENV_APPLY_KEYS,
) =>
  Effect.forEach(
    keys,
    (key) => {
      const value = loaded[key];
      if (value === undefined || process.env[key] !== undefined) {
        return Effect.void;
      }
      return Effect.acquireRelease(
        Effect.sync(() => {
          process.env[key] = value;
        }),
        () =>
          Effect.sync(() => {
            delete process.env[key];
          }),
      );
    },
    { discard: true },
  );

function nonEmptyString(value: unknown): Option.Option<string> {
  return typeof value === "string" && value.length > 0 ? Option.some(value) : Option.none();
}

/**
 * Resolve a `[section] enabled` style bool. Go decodes a TOML bool natively and a
 * string (incl. an `env(VAR)` reference) via `strconv.ParseBool` — so `"1"`/`"t"`/etc.
 * count as true and a malformed value aborts the load. Returns `"invalid"` for a
 * malformed string so the caller can fail with Go's config error; applies the schema
 * default (`auth`/`storage`/`realtime` default `true`) when the key is absent.
 */
function resolveBool(value: unknown, fallback: boolean, lookup: EnvLookup): boolean | "invalid" {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const parsed = legacyParseGoBool(legacyExpandEnv(value, lookup));
    return parsed ?? "invalid";
  }
  // A numeric config value decodes into a bool under weak typing: `value != 0`. A TOML
  // number (`enabled = 0`) is therefore an explicit false, NOT absent — it must not fall
  // through to the schema default.
  if (typeof value === "number") return value !== 0;
  // Absent → the schema default. A PRESENT non-scalar (array/inline table, e.g.
  // `enabled = []`) is a decode error, so it must NOT fall through to the default —
  // otherwise `db reset` could accept the prompt and drop schemas on a config that
  // should have already failed validation.
  if (value === undefined) return fallback;
  return "invalid";
}

/**
 * `resolveBool` that fails the config load on a malformed bool. `envValue` is
 * the `SUPABASE_*` env override: when set it wins over the TOML value/default
 * (`envOverride` already drops empty values). The override is still a
 * string-kind value, so an `env(VAR)` indirection
 * (`SUPABASE_DB_SEED_ENABLED=env(SEED_ON)`) is expanded before the bool
 * parse.
 */
const resolveBoolOrFail = Effect.fnUntraced(function* (
  field: string,
  value: unknown,
  fallback: boolean,
  lookup: EnvLookup,
  envValue?: string,
) {
  if (envValue !== undefined) {
    const parsed = legacyParseGoBool(legacyExpandEnv(envValue, lookup));
    if (parsed === undefined) {
      return yield* Effect.fail(
        new LegacyDbConfigLoadError({ message: `failed to parse config: invalid ${field}.` }),
      );
    }
    return parsed;
  }
  const resolved = resolveBool(value, fallback, lookup);
  if (resolved === "invalid") {
    return yield* Effect.fail(
      new LegacyDbConfigLoadError({ message: `failed to parse config: invalid ${field}.` }),
    );
  }
  return resolved;
});

/**
 * Tri-state (`*bool`) sibling of `resolveBoolOrFail` for fields decoded as a
 * pointer-bool (absent → `None`, never `false`). The `SUPABASE_*` env override
 * wins when present; otherwise a present TOML bool/string is decoded with the
 * accepted bool-spelling set (`legacyParseGoBool`) and a malformed value
 * aborts the load with a `failed to parse config` error. An absent value
 * stays `None`. (`envOverride` already drops empty env values.)
 */
const resolveOptionalBoolOrFail = Effect.fnUntraced(function* (
  field: string,
  envValue: string | undefined,
  value: unknown,
  lookup: EnvLookup,
) {
  if (envValue !== undefined) {
    const parsed = legacyParseGoBool(legacyExpandEnv(envValue, lookup));
    if (parsed === undefined) {
      return yield* Effect.fail(
        new LegacyDbConfigLoadError({ message: `failed to parse config: invalid ${field}.` }),
      );
    }
    return Option.some(parsed);
  }
  if (typeof value === "boolean") return Option.some(value);
  // Numeric `*bool` value decodes the same way under weak typing: `value != 0`.
  if (typeof value === "number") return Option.some(value !== 0);
  if (typeof value === "string") {
    const parsed = legacyParseGoBool(legacyExpandEnv(value, lookup));
    if (parsed === undefined) {
      return yield* Effect.fail(
        new LegacyDbConfigLoadError({ message: `failed to parse config: invalid ${field}.` }),
      );
    }
    return Option.some(parsed);
  }
  // Absent → `None` (`*bool` stays nil). A present non-scalar value is a decode
  // failure, so reject it here rather than silently treating it as absent.
  if (value === undefined) return Option.none<boolean>();
  return yield* Effect.fail(
    new LegacyDbConfigLoadError({ message: `failed to parse config: invalid ${field}.` }),
  );
});

const LEGACY_VAULT_SECRET_PATH = ["db", "vault", "*"] as const;

/**
 * Dotted paths of every secret-typed config field that must be decryptable —
 * `*` matches any map key (`auth.external.<provider>`, `auth.hook.<name>`,
 * `db.vault.<name>`). `[db.vault]` (a name-to-secret map) IS included — the
 * db-config reader below also decrypts it directly in its own body
 * ({@link legacyReadDbToml}'s `vault` loop) with the same
 * fail-on-undecryptable behaviour, so for that caller this just detects the
 * same failure a little earlier (no observable difference: same
 * `legacyDecryptSecret` call, same `failed to parse config: <cause>`
 * message). For `config push` — the other caller of
 * {@link legacyAssertDecryptableSecrets}, which has no such downstream vault
 * pass — omitting `db.vault` here would let an undecryptable vault secret
 * through to the API calls. Update alongside any new secret-typed field.
 */
const LEGACY_SECRET_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  ["db", "root_key"],
  LEGACY_VAULT_SECRET_PATH,
  ["auth", "publishable_key"],
  ["auth", "secret_key"],
  ["auth", "jwt_secret"],
  ["auth", "anon_key"],
  ["auth", "service_role_key"],
  ["auth", "email", "smtp", "pass"],
  ["auth", "external", "*", "secret"],
  ["auth", "hook", "*", "secrets"],
  ["auth", "sms", "twilio", "auth_token"],
  ["auth", "sms", "twilio_verify", "auth_token"],
  ["auth", "sms", "messagebird", "access_key"],
  ["auth", "sms", "textlocal", "api_key"],
  ["auth", "sms", "vonage", "api_secret"],
  ["auth", "captcha", "secret"],
  ["studio", "openai_api_key"],
  // `[edge_runtime.secrets]` is a name-to-secret map, so every value must be decryptable —
  // `*` spans the arbitrary secret names.
  ["edge_runtime", "secrets", "*"],
];

/** Collects the string leaves reachable from `node` along `segs` (`*` spans map keys). */
const legacyCollectSecretStrings = (
  node: unknown,
  segs: ReadonlyArray<string>,
  index: number,
  out: Array<string>,
): void => {
  if (index === segs.length) {
    if (typeof node === "string") out.push(node);
    return;
  }
  const record = asRecord(node);
  if (record === undefined) return;
  const seg = segs[index]!;
  if (seg === "*") {
    for (const key of Object.keys(record)) {
      legacyCollectSecretStrings(record[key], segs, index + 1, out);
    }
  } else {
    legacyCollectSecretStrings(record[seg], segs, index + 1, out);
  }
};

/** Returns Go's hook-error message when a single `encrypted:` secret value cannot be decrypted. */
const legacyAssertSecretValue = (
  value: string,
  lookup: EnvLookup,
  dotenvPrivateKeys: ReadonlyArray<string>,
): string | undefined => {
  const expanded = legacyExpandEnv(value, lookup);
  // Unset `env(...)` and plain strings are returned verbatim by Go's hook (no error).
  if (ENV_PATTERN.test(expanded) || !legacyIsEncryptedSecret(expanded)) return undefined;
  const decrypted = legacyDecryptSecret(expanded, dotenvPrivateKeys);
  return decrypted.ok ? undefined : `failed to parse config: ${decrypted.error}`;
};

/**
 * Asserts every `config.Secret`-typed `encrypted:` value in the (merged) config can be
 * decrypted, mirroring Go's global `DecryptSecretHookFunc`, which aborts the load with
 * `failed to parse config: <error>` when a secret cannot be decrypted. Only the actual
 * `Secret` field paths ({@link LEGACY_SECRET_PATHS}) are scanned — a non-secret string that
 * merely starts with `encrypted:` (e.g. an auth email-template `subject`) stays plain text
 * in Go and must not block the load. Go decodes every `[remotes.<name>]` block into the same
 * struct, so the same paths are checked under each remote too. Returns Go's error message (or
 * `undefined`); callers surface it as their own domain error (e.g. `Effect.fail`).
 *
 * Shared across command families: the db-config reader below uses it for `db push`/`db
 * reset`/`migration up|down`/etc, and `config push`'s handler reuses it directly against its
 * own (`@supabase/config`-decoded) document — both need the exact same "decrypt-or-abort before
 * anything else runs" behaviour Go gets for free from `config.Load`.
 *
 * The "check every `[remotes.<name>]` block too" part of that contract only holds when `doc`
 * still has an intact `remotes` key. The db-config reader's own remote-merge keeps it (so this
 * function really does check every declared remote there), but `@supabase/config`'s
 * `loadProjectConfig` strips `remotes` from the document once a block matches the target ref —
 * so for `config push`, an undecryptable secret hiding in a *different, non-matching* remote
 * block goes unchecked (see that command's SIDE_EFFECTS.md KNOWN GAPS).
 */
export const legacyAssertDecryptableSecrets = (
  doc: unknown,
  lookup: EnvLookup,
  dotenvPrivateKeys: ReadonlyArray<string>,
  opts?: { readonly includeVault?: boolean },
): string | undefined => {
  const scan = (node: unknown): string | undefined => {
    for (const segs of LEGACY_SECRET_PATHS) {
      if (opts?.includeVault === false && segs === LEGACY_VAULT_SECRET_PATH) continue;
      const values: Array<string> = [];
      legacyCollectSecretStrings(node, segs, 0, values);
      for (const value of values) {
        const error = legacyAssertSecretValue(value, lookup, dotenvPrivateKeys);
        if (error !== undefined) return error;
      }
    }
    return undefined;
  };
  const topLevel = scan(doc);
  if (topLevel !== undefined) return topLevel;
  const remotes = asRecord(asRecord(doc)?.["remotes"]);
  if (remotes !== undefined) {
    for (const name of Object.keys(remotes)) {
      const error = scan(remotes[name]);
      if (error !== undefined) return error;
    }
  }
  return undefined;
};

// Go merges the template default before Validate (`templates/config.toml`), so an absent
// `auth.site_url` is non-empty; only an explicit empty string fails A1.
const DEFAULT_AUTH_SITE_URL = "http://127.0.0.1:3000";

/**
 * Reads `<workdir>/supabase/config.toml` (db subtree + project id) and the linked
 * `<workdir>/supabase/.temp/pooler-url`. `fs`/`path` are passed in so the resolver
 * can capture them once and keep its own `R` at `never`.
 *
 * Fails with `LegacyDbConfigLoadError` only when the config file is present but
 * unparseable; an absent file (and an absent/empty pooler-url file) is not an error.
 */
const readDbTomlCore = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  // When set (the explicitly-linked path only), a `[remotes.<name>]` block whose
  // `project_id` equals `ref` is merged over the base config before fields are read.
  // `--local` / `--db-url` / declarative pass nothing and read the unmerged config
  // (those paths never resolve a ref before config load).
  ref?: string,
  // Internal: when true the on-disk `config.toml` is treated as absent so the body
  // resolves pure defaults (still honoring `SUPABASE_*` env overrides, which Go binds
  // regardless of a config file). The lenient `legacyReadDbToml({ validate: false })`
  // wrapper uses this as its fallback after a config-load failure, mirroring the
  // best-effort behavior the container-id seam relied on before.
  ignoreConfigFile = false,
  // Internal: gates the `assertEnvLoaded` OrioleDB S3 stderr WARN below (review:
  // Codex, PR #6022). This reader should run exactly once per command invocation, so
  // the warning prints at most once. `start`/`db start`'s fresh-volume bootstrap calls
  // this reader more than once in a single invocation — once purely for its validation
  // side effect (`start.handler.ts:614`, `db/start/start.handler.ts:125`, both discard
  // the result), then again internally wherever a resolved value is actually needed
  // (`legacyIsLocalDbRunning`'s best-effort `projectId` probe,
  // `legacyRunFreshDbSetup`'s own accepted duplicate config-load pass —
  // see `db-bootstrap/db-setup.ts`'s header). Those internal re-reads pass
  // `false` so the warning still fires exactly once per invocation instead of
  // two or three times.
  warnOnUnresolvedEnv = true,
  resolveVaultSecrets = true,
) {
  const supabaseDir = path.join(workdir, "supabase");
  const configPath = path.join(supabaseDir, "config.toml");

  // Distinguish "absent" (→ defaults) from "present but unreadable/malformed" (→ fail),
  // matching `mergeFileConfig`: only `os.ErrNotExist`
  // is swallowed, every other read error aborts rather than silently running against the
  // default local database. Effect surfaces "not found" as `PlatformError` with a
  // `SystemError` reason tagged `"NotFound"`.
  const maybeContent = ignoreConfigFile
    ? Option.none<string>()
    : yield* fs.readFileString(configPath).pipe(
        Effect.map(Option.some<string>),
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new LegacyDbConfigLoadError({
                  message: `failed to read file config: ${error.message}`,
                }),
              ),
        ),
      );

  // Resolve `env(VAR)` against the shell env first, then the project `.env` files. Built
  // here — before the remote-config validation/merge below — so remote and
  // top-level `project_id` env() forms are expanded before they are validated or
  // used to derive Docker IDs.
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, workdir);
  const lookup: EnvLookup = (name) => process.env[name] ?? projectEnv[name];
  // dotenvx private keys for decrypting `encrypted:` secrets, from the shell + project
  // env. Used by the global secret-decryptability assertion below and the `[db.vault]`
  // resolution.
  const dotenvPrivateKeys = legacyCollectDotenvPrivateKeys({ ...projectEnv, ...process.env });

  let db: RawDoc | undefined;
  let pgDeltaRaw: RawDoc | undefined;
  let authRaw: RawDoc | undefined;
  let storageRaw: RawDoc | undefined;
  let realtimeRaw: RawDoc | undefined;
  let apiRaw: RawDoc | undefined;
  let edgeRuntimeRaw: RawDoc | undefined;
  let experimentalRaw: RawDoc | undefined;
  let functionsRaw: RawDoc | undefined;
  let analyticsRaw: RawDoc | undefined;
  let projectId = Option.none<string>();
  // Whether `config.toml` set a top-level `project_id` string that env-expanded to empty
  // (`project_id = ""`). That empty override is kept and validation fails with
  // `Missing required field in config: project_id`; tracked here so the
  // check can run after the `SUPABASE_PROJECT_ID` env override below may still rescue it.
  let projectIdExplicitEmpty = false;
  // Config keys a matched remote block contributed at override tier, so they must beat
  // the matching `SUPABASE_*` env overrides below.
  let remoteOverrideKeys: ReadonlySet<string> = new Set();
  // The matched `[remotes.<name>]` block name, echoed as the config-override line.
  let appliedRemote: string | undefined;
  if (Option.isSome(maybeContent)) {
    let doc: RawDoc | undefined;
    try {
      doc = asRecord(SmolToml.parse(maybeContent.value));
    } catch (cause) {
      return yield* Effect.fail(
        new LegacyDbConfigLoadError({
          message: `failed to load config: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      );
    }
    // Config load aborts when two `[remotes.*]` blocks share a `project_id`,
    // regardless of which command runs — check before merging.
    const duplicateRemote = findDuplicateRemoteProjectId(doc, lookup);
    if (duplicateRemote !== undefined) {
      return yield* Effect.fail(
        new LegacyDbConfigLoadError({
          message: `duplicate project_id for [remotes.${duplicateRemote.name}] and [remotes.${duplicateRemote.other}]`,
        }),
      );
    }
    // Validation rejects any remote whose `project_id` is not a valid 20-char ref, on
    // every load, after the duplicate check. So a malformed remote fails even
    // local/direct commands before any DB connection.
    const invalidRemote = findInvalidRemoteProjectId(doc, lookup);
    if (invalidRemote !== undefined) {
      return yield* Effect.fail(
        new LegacyDbConfigLoadError({
          message: `Invalid config for remotes.${invalidRemote}.project_id. Must be like: abcdefghijklmnopqrst`,
        }),
      );
    }
    // Apply a matching `[remotes.<name>]` override: merge the block whose
    // `project_id` equals the resolved ref over the base.
    const remoteOverride =
      ref === undefined
        ? { doc, remoteOverrideKeys: new Set<string>() }
        : applyRemoteOverride(doc, ref, lookup);
    const effectiveDoc = remoteOverride.doc;
    remoteOverrideKeys = remoteOverride.remoteOverrideKeys;
    appliedRemote = remoteOverride.appliedRemote;
    db = asRecord(effectiveDoc?.["db"]);
    experimentalRaw = asRecord(effectiveDoc?.["experimental"]);
    pgDeltaRaw = asRecord(experimentalRaw?.["pgdelta"]);
    authRaw = asRecord(effectiveDoc?.["auth"]);
    storageRaw = asRecord(effectiveDoc?.["storage"]);
    realtimeRaw = asRecord(effectiveDoc?.["realtime"]);
    apiRaw = asRecord(effectiveDoc?.["api"]);
    edgeRuntimeRaw = asRecord(effectiveDoc?.["edge_runtime"]);
    functionsRaw = asRecord(effectiveDoc?.["functions"]);
    analyticsRaw = asRecord(effectiveDoc?.["analytics"]);
    // `env(VAR)` for the top-level `project_id` must be expanded before the derived
    // Docker container names are computed from it — otherwise a
    // `project_id = "env(PROJECT_ID)"` would sanitize to a wrong local-stack id like
    // `supabase_db_env_PROJECT_ID_`.
    const rawProjectId = effectiveDoc?.["project_id"];
    projectId = nonEmptyString(
      typeof rawProjectId === "string" ? legacyExpandEnv(rawProjectId, lookup) : rawProjectId,
    );
    // A present `project_id` string that resolves to empty is a "kept empty override".
    projectIdExplicitEmpty = typeof rawProjectId === "string" && Option.isNone(projectId);

    // Every secret-typed field in the merged config must be decryptable, so an
    // `encrypted:` secret anywhere (e.g. no DOTENV_PRIVATE_KEY) aborts the load with
    // `failed to parse config: <error>` — before validation and before connecting.
    // This covers `[db.vault]` unless the caller is
    // explicitly skipping Vault sync, so the vault loop below only materializes values
    // that this assertion has already proved decryptable.
    const secretError = legacyAssertDecryptableSecrets(effectiveDoc, lookup, dotenvPrivateKeys, {
      includeVault: resolveVaultSecrets,
    });
    if (secretError !== undefined) {
      return yield* Effect.fail(new LegacyDbConfigLoadError({ message: secretError }));
    }
  }
  // `remoteOverrideKeys` has its final value from here on — see `legacyMakeRemoteWins`'s own doc
  // comment for why this is typed narrower than the `ReadonlySet<string>` it wraps.
  const remoteWins = legacyMakeRemoteWins(remoteOverrideKeys);

  // Read the linked pooler URL from `.temp/pooler-url` and treat it as configured only
  // when the file exists and is non-empty.
  const poolerUrlPath = path.join(supabaseDir, ".temp", "pooler-url");
  const poolerConnectionString = yield* fs
    .readFileString(poolerUrlPath)
    .pipe(Effect.map(nonEmptyString), Effect.orElseSucceed(Option.none<string>));

  // The legacy pg-delta npm version is read from
  // `.temp/pgdelta-version` (trimmed, non-empty) during Load, never from the
  // TOML. An absent/empty file leaves it `None` (callers fall back to the
  // default via `legacyEffectivePgDeltaNpmVersion`). The bundled next engine is
  // fixed at CLI build time and ignores this compatibility setting.
  const pgDeltaVersionPath = path.join(supabaseDir, ".temp", "pgdelta-version");
  const pgDeltaNpmVersion = yield* fs.readFileString(pgDeltaVersionPath).pipe(
    Effect.map((content) => nonEmptyString(content.trim())),
    Effect.orElseSucceed(Option.none<string>),
  );

  // `SUPABASE_DB_*` env vars override the matching `[db]` field before the TOML
  // value/default. An empty env value is ignored, and the project `.env` files are
  // loaded into the environment first, so consult both.
  const envOverride = (name: string): string | undefined => {
    const fromShell = process.env[name];
    if (fromShell !== undefined && fromShell.length > 0) return fromShell;
    const fromFile = projectEnv[name];
    return fromFile !== undefined && fromFile.length > 0 ? fromFile : undefined;
  };

  // `SUPABASE_PROJECT_ID` overrides the top-level `project_id` before the local-stack
  // container/network names (`NetId = supabase_network_<project_id>`) are derived from
  // it. The reader's `projectId` is exactly that Docker-naming id, so apply the
  // override here (env-expanded like the TOML value, then sanitized at the consumer) —
  // otherwise `test db --local` would join `supabase_network_<toml-or-basename>`
  // instead of honoring the env id. This is independent of the linked-ref resolver,
  // which reads the env var on its own chain; the env value is bound regardless of
  // whether a config file exists. UNLESS a matched `[remotes.<ref>]` block already set
  // `project_id` at override tier (`remoteWins("project_id")` — NOT guaranteed whenever
  // `appliedRemote` is set: a block can also match purely via its own
  // `SUPABASE_REMOTES_<NAME>_PROJECT_ID` env override with no literal `project_id` key,
  // in which case this stays `false` — see `LEGACY_ENV_OVERRIDABLE_KEYS`'s own doc
  // comment on that key): that override-tier value, when present, outranks the ambient
  // env tier, so a stale/differently-scoped `SUPABASE_PROJECT_ID` must not clobber it —
  // otherwise a linked `db diff`/`db pull` mounts the wrong `supabase_edge_runtime_<id>`
  // Deno-cache volume for the matched remote (review: PRRT_kwDOErm0O86XHGDL).
  const projectIdEnv = remoteWins("project_id") ? undefined : envOverride("SUPABASE_PROJECT_ID");
  if (projectIdEnv !== undefined) {
    projectId = nonEmptyString(legacyExpandEnv(projectIdEnv, lookup));
  }

  // Validation rejects an empty top-level `project_id`. An absent field is tolerated
  // here (deferred), but a present `project_id = ""` that the `SUPABASE_PROJECT_ID`
  // override did not rescue is a load error, so a destructive command (e.g. remote
  // `db reset`) fails fast rather than dropping schemas on a config that should have
  // already failed validation.
  if (projectIdExplicitEmpty && Option.isNone(projectId)) {
    return yield* Effect.fail(
      new LegacyDbConfigLoadError({ message: "Missing required field in config: project_id" }),
    );
  }

  // A present-but-unmarshalable port aborts rather than defaulting, so `test db
  // --local` never silently targets the default local database while hiding a broken
  // `[db]` config.
  const port = resolvePort(
    (remoteWins("db.port") ? undefined : envOverride("SUPABASE_DB_PORT")) ?? db?.["port"],
    DEFAULT_PORT,
    lookup,
  );
  const shadowPort = resolvePort(
    (remoteWins("db.shadow_port") ? undefined : envOverride("SUPABASE_DB_SHADOW_PORT")) ??
      db?.["shadow_port"],
    DEFAULT_SHADOW_PORT,
    lookup,
  );
  if (port === undefined || shadowPort === undefined) {
    return yield* Effect.fail(
      new LegacyDbConfigLoadError({
        message: `failed to load config: invalid ${port === undefined ? "db.port" : "db.shadow_port"} value`,
      }),
    );
  }
  // Validation rejects an explicit `db.port = 0`; an absent port is defaulted before
  // validation, so only a present 0 fails. `resolvePort` accepts 0 as a syntactically
  // valid uint16, so the zero check lives here. No equivalent check for `shadow_port`.
  if (port === 0) {
    return yield* Effect.fail(
      new LegacyDbConfigLoadError({ message: "Missing required field in config: db.port" }),
    );
  }

  // `db.password` isn't part of the config schema (no `SUPABASE_DB_PASSWORD` env
  // binding, and the local password otherwise defaults to `"postgres"`). Honoring a
  // literal `[db] password` toml key here is a deliberate TS extension (established
  // for `--local` connections, `legacy-db-config.layer.ts`). `DB_PASSWORD` is read only
  // by linked password resolution (`legacy-db-config.layer.ts`), so the local password
  // must not source it or `db query --local` etc. would authenticate with a remote
  // secret.
  const passwordRaw = typeof db?.["password"] === "string" ? db["password"] : undefined;

  // A quoted `env(VAR)` reference for `major_version` is expanded and then decoded
  // into a `uint`, strictly rejecting a non-integer string (`17foo` is NOT truncated
  // to 17), resolving `env(PG_MAJOR)` before validation. `resolveConfigInt` does
  // this; `SUPABASE_DB_MAJOR_VERSION` overrides the TOML value.
  const majorVersionRaw =
    (remoteWins("db.major_version") ? undefined : envOverride("SUPABASE_DB_MAJOR_VERSION")) ??
    db?.["major_version"];
  const majorVersionResolved = resolveConfigInt(majorVersionRaw, lookup);
  if (majorVersionResolved === "invalid") {
    // Present but not a whole integer (`17foo`, or an `env(VAR)` that does not
    // resolve to digits): fail the config parse rather than defaulting.
    const shown =
      typeof majorVersionRaw === "string"
        ? legacyExpandEnv(majorVersionRaw, lookup)
        : String(majorVersionRaw);
    return yield* Effect.fail(
      new LegacyDbConfigLoadError({
        message: `Failed reading config: Invalid db.major_version: ${shown}.`,
      }),
    );
  }
  // Rejecting an unsupported major version ({13,14,15,17}) is
  // `legacyValidateResolvedConfig`'s `db.major_version` switch (called once, below) — an
  // absent value falls through to the default (zero-then-default) and a present one
  // (including `0`) flows into `input.db.majorVersion` for that switch to check.
  const majorVersion =
    typeof majorVersionResolved === "number" ? majorVersionResolved : DEFAULT_MAJOR_VERSION;

  // `[experimental] orioledb_version`: on a 15/17 project, validation rewrites the
  // Postgres image to the OrioleDB tag and `assertEnvLoaded`s the four S3 fields.
  // Expand env() like every other field; the image rewrite itself is applied by
  // `legacyResolveDbImage`.
  const expandString = (value: unknown): Option.Option<string> =>
    typeof value === "string" ? nonEmptyString(legacyExpandEnv(value, lookup)) : Option.none();
  const orioledbVersion = expandString(experimentalRaw?.["orioledb_version"]);
  if (Option.isSome(orioledbVersion) && (majorVersion === 15 || majorVersion === 17)) {
    // `assertEnvLoaded` warns (does NOT fail) for any S3 value still holding an
    // unexpanded `env(VAR)` after env loading. Match the
    // stderr line byte-for-byte; the env var name is the `env(...)` capture.
    const s3Fields = ["s3_host", "s3_region", "s3_access_key", "s3_secret_key"] as const;
    for (const field of s3Fields) {
      const raw = experimentalRaw?.[field];
      if (typeof raw !== "string") continue;
      const expanded = legacyExpandEnv(raw, lookup);
      const unset = ENV_PATTERN.exec(expanded);
      if (unset !== null && warnOnUnresolvedEnv) {
        process.stderr.write(`WARN: environment variable is unset: ${unset[1] ?? ""}\n`);
      }
    }
  }

  // `[edge_runtime] deno_version` (default 2). The edge-runtime image switches to the
  // `deno1` tag when this is 1; the declarative pg-delta runner needs it to pick the
  // matching image. `SUPABASE_EDGE_RUNTIME_DENO_VERSION` overrides the TOML before
  // validation (same env-override precedence as the pg-delta env vars below), so a CI
  // env override decides which edge-runtime image pg-delta runs under.
  const denoVersionRaw =
    (remoteWins("edge_runtime.deno_version")
      ? undefined
      : envOverride("SUPABASE_EDGE_RUNTIME_DENO_VERSION")) ?? edgeRuntimeRaw?.["deno_version"];
  // `deno_version` decodes into a `uint` before validation, so a present non-integer
  // string (`2foo`) or an unresolved `env(MISSING)` aborts the load rather than falling
  // through to the default Deno 2 image. `resolveConfigInt` expands `env()` then requires
  // a whole integer; the validation switch handles the rest.
  const denoVersionResolved = resolveConfigInt(denoVersionRaw, lookup);
  if (denoVersionResolved === "invalid") {
    const shown =
      typeof denoVersionRaw === "string"
        ? legacyExpandEnv(denoVersionRaw, lookup)
        : String(denoVersionRaw);
    return yield* Effect.fail(
      new LegacyDbConfigLoadError({
        message: `Failed reading config: Invalid edge_runtime.deno_version: ${shown}.`,
      }),
    );
  }
  // Rejecting a present-but-invalid deno_version (0 → missing-required, anything other
  // than 1/2 → invalid) is `legacyValidateResolvedConfig`'s `edgeRuntimeDenoVersion`
  // switch (called once, below). An absent key falls through to the default
  // (deno_version=2).
  const denoVersion =
    typeof denoVersionResolved === "number" ? denoVersionResolved : DEFAULT_DENO_VERSION;

  // `[experimental.webhooks]`. `*webhooks` is a nil-unless-declared pointer sibling of
  // `*PgDeltaConfig` below. The section only exists to be turned ON: ANY present
  // `[experimental.webhooks]` whose `enabled` isn't explicitly `true` is rejected,
  // including when the key is simply omitted (bool zero-value `false`).
  // `webhooksPresent`/`webhooksEnabled` feed `legacyValidateResolvedConfig`'s existing
  // `experimental.webhooks` check (`legacy-config-validate.ts:676-680`) — this D pipeline never
  // populated that input pair, so the check never ran for any of D's ~15 db/migration-command
  // callers (`db start`, `db reset`, `db push`, `start`, migrate-and-seed), unlike L's
  // `legacyResolveLocalConfigValues`, which already computes the identical pair from its own
  // decoded config + raw document (review: PRRT_kwDOErm0O86WE42i).
  //
  // UNLIKE `experimental.pgdelta.enabled` below, the `SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED`
  // env override is NOT presence-independent — verified empirically: loading a config with no
  // `[experimental.webhooks]` section and a malformed env value succeeds and leaves
  // `Experimental.Webhooks` unset, silently ignoring the override, where the equivalent pgdelta
  // probe fails to load. The difference is the default-merge order: the template merged before
  // the user's file declares `[experimental.pgdelta]` but has no `[experimental.webhooks]` entry
  // at all — so `pgdelta.enabled` is always a "known" key (env-bindable regardless of the user's
  // own file), while `webhooks.enabled` is only known, and therefore only env-overridable, when
  // the section itself is declared (by the user's file or a matching `[remotes.*]` block — both
  // already folded into `experimentalRaw` above). Gate the env read itself on `webhooksPresent`,
  // not just the later validation check, so a bogus/irrelevant
  // `SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED` in the shell or project `.env` doesn't abort a load
  // that has no `[experimental.webhooks]` section to apply it to (review: this thread).
  const webhooksRaw = asRecord(experimentalRaw?.["webhooks"]);
  const webhooksPresent = webhooksRaw !== undefined;
  const webhooksEnabledRaw = webhooksRaw?.["enabled"];
  const webhooksEnabledEnv = webhooksPresent
    ? remoteWins("experimental.webhooks.enabled")
      ? undefined
      : envOverride("SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED")
    : undefined;
  let webhooksEnabled: boolean;
  if (webhooksEnabledEnv !== undefined) {
    const expandedWebhooksEnabledEnv = legacyExpandEnv(webhooksEnabledEnv, lookup);
    const parsed = legacyParseGoBool(expandedWebhooksEnabledEnv);
    if (parsed === undefined) {
      return yield* Effect.fail(
        new LegacyDbConfigLoadError({
          message: `failed to parse config: invalid experimental.webhooks.enabled: ${expandedWebhooksEnabledEnv}.`,
        }),
      );
    }
    webhooksEnabled = parsed;
  } else if (typeof webhooksEnabledRaw === "boolean") {
    webhooksEnabled = webhooksEnabledRaw;
  } else if (typeof webhooksEnabledRaw === "number") {
    // Go decodes the whole config under mapstructure's weak typing, so a numeric `enabled = 1`
    // is true (`value != 0`) — same rule as `experimental.pgdelta.enabled` below.
    webhooksEnabled = webhooksEnabledRaw !== 0;
  } else if (typeof webhooksEnabledRaw === "string") {
    const parsed = legacyParseGoBool(legacyExpandEnv(webhooksEnabledRaw, lookup));
    if (parsed === undefined) {
      return yield* Effect.fail(
        new LegacyDbConfigLoadError({
          message: `failed to parse config: invalid experimental.webhooks.enabled: ${legacyExpandEnv(webhooksEnabledRaw, lookup)}.`,
        }),
      );
    }
    webhooksEnabled = parsed;
  } else {
    webhooksEnabled = false;
  }

  // `[experimental.pgdelta]`. `enabled` is a TOML bool (Go decodes weakly, so an
  // `env(VAR)`/string "true" also counts); `declarative_schema_path` is resolved
  // to a `supabase/`-prefixed path when relative (`config.resolve`).
  // Go's viper `AutomaticEnv` lets `SUPABASE_EXPERIMENTAL_PGDELTA_*` override the
  // TOML before validation (`config.go` `SetEnvPrefix("SUPABASE")` + `.`→`_`), so a
  // CI env override decides the gate / paths. `envOverride` is the shell→project-.env
  // lookup that ignores empty values, matching viper.
  const enabledRaw = pgDeltaRaw?.["enabled"];
  const enabledEnv = remoteWins("experimental.pgdelta.enabled")
    ? undefined
    : envOverride("SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED");
  // Go decodes this bool via `strconv.ParseBool` (mapstructure weakly typed), so `"1"`
  // counts as true and a malformed value (`SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=maybe`)
  // aborts the load. The env override wins (viper AutomaticEnv), then the TOML bool, then
  // an `env(VAR)` string, defaulting to false when absent.
  let enabled: boolean;
  if (enabledEnv !== undefined) {
    // The AutomaticEnv override is decoded through `LoadEnvHook`, so an `env(VAR)`
    // indirection is expanded before the weak `ParseBool` decode.
    const expandedEnabledEnv = legacyExpandEnv(enabledEnv, lookup);
    const parsed = legacyParseGoBool(expandedEnabledEnv);
    if (parsed === undefined) {
      return yield* Effect.fail(
        new LegacyDbConfigLoadError({
          message: `failed to parse config: invalid experimental.pgdelta.enabled: ${expandedEnabledEnv}.`,
        }),
      );
    }
    enabled = parsed;
  } else if (typeof enabledRaw === "boolean") {
    enabled = enabledRaw;
  } else if (typeof enabledRaw === "number") {
    // Go decodes the whole config under mapstructure's weak typing, so a numeric
    // `enabled = 1` is true (`value != 0`) — same rule as the generic `resolveBool`.
    enabled = enabledRaw !== 0;
  } else if (typeof enabledRaw === "string") {
    const parsed = legacyParseGoBool(legacyExpandEnv(enabledRaw, lookup));
    if (parsed === undefined) {
      return yield* Effect.fail(
        new LegacyDbConfigLoadError({
          message: `failed to parse config: invalid experimental.pgdelta.enabled: ${legacyExpandEnv(enabledRaw, lookup)}.`,
        }),
      );
    }
    enabled = parsed;
  } else {
    enabled = false;
  }

  const declarativeSchemaPathRaw = pgDeltaRaw?.["declarative_schema_path"];
  // The AutomaticEnv override and the TOML literal both flow through `LoadEnvHook`
  // under `UnmarshalExact`, so an `env(VAR)` indirection is expanded
  // before the path is used — whichever source wins. Expand once over the resolved value
  // (`legacyExpandEnv` is a no-op on a non-`env()` string).
  const declarativeSchemaPathValue = legacyExpandEnv(
    (remoteWins("experimental.pgdelta.declarative_schema_path")
      ? undefined
      : envOverride("SUPABASE_EXPERIMENTAL_PGDELTA_DECLARATIVE_SCHEMA_PATH")) ??
      (typeof declarativeSchemaPathRaw === "string" ? declarativeSchemaPathRaw : ""),
    lookup,
  );
  let declarativeSchemaPath = Option.none<string>();
  if (declarativeSchemaPathValue.length > 0) {
    declarativeSchemaPath = Option.some(
      path.isAbsolute(declarativeSchemaPathValue)
        ? declarativeSchemaPathValue
        : path.join("supabase", declarativeSchemaPathValue),
    );
  }

  const formatOptionsRaw = pgDeltaRaw?.["format_options"];
  // Same `LoadEnvHook` path: expand the resolved value (env override or TOML literal) before
  // the JSON validation below runs.
  const formatOptionsExpanded = legacyExpandEnv(
    (remoteWins("experimental.pgdelta.format_options")
      ? undefined
      : envOverride("SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS")) ??
      (typeof formatOptionsRaw === "string" ? formatOptionsRaw : ""),
    lookup,
  );
  // Rejecting a non-empty, non-JSON `format_options` is `legacyValidateResolvedConfig`'s
  // `experimental.pgdeltaFormatOptions` check (called once, below).
  const formatOptions = nonEmptyString(formatOptionsExpanded);

  // Bucket-name/function-slug validation lives in `legacyValidateResolvedConfig` (called
  // once, below); only the pure extraction stays here.
  const bucketsRaw = asRecord(storageRaw?.["buckets"]);
  // Same gap for each bucket's own `file_size_limit` — Go decodes it via the same `sizeInBytes`
  // hook as the storage-level default (validated eagerly in `start.handler.ts`), unconditionally
  // during `Config.Load`, for every configured bucket, before any command-specific logic runs.
  // This reader only ever extracted bucket NAMES above — the per-bucket size itself was only
  // parsed deep inside `legacySeedBucketsRun`, reached only on a fresh volume with Storage
  // actually started, so a malformed value on a reused-volume restart (or the already-running
  // short-circuit, which never reaches bring-up at all) went completely unvalidated. An absent
  // key is skipped (Go's decode hook never fires over one; the bucket inherits the storage-level
  // default later). Validate-only: `legacySeedBucketsRun`'s own call re-parses the real value.
  if (bucketsRaw !== undefined) {
    for (const [bucketName, bucketRaw] of Object.entries(bucketsRaw)) {
      const rawLimit = asRecord(bucketRaw)?.["file_size_limit"];
      if (typeof rawLimit !== "string" && typeof rawLimit !== "number") continue;
      const limitString =
        typeof rawLimit === "number" ? String(rawLimit) : legacyExpandEnv(rawLimit, lookup);
      try {
        ramInBytes(limitString);
      } catch {
        return yield* Effect.fail(
          new LegacyDbConfigLoadError({
            message: `failed to parse config: invalid storage.buckets.${bucketName}.file_size_limit.`,
          }),
        );
      }
    }
  }

  // Go's config.Validate runs the full `if c.Auth.Enabled` block after
  // the bucket/function checks. Gated on `auth.enabled` (default true); Go's viper AutomaticEnv
  // binds `auth.enabled` to `SUPABASE_AUTH_ENABLED` before Validate, so the
  // env override decides whether the auth block is validated — UNLESS a matched `[remotes.*]`
  // block supplies `auth.enabled` itself, in which case `mergeRemoteConfig`'s `v.Set` (override
  // tier, above `AutomaticEnv`) wins, matching the same suppression every other
  // `LEGACY_ENV_OVERRIDABLE_KEYS` entry gets below.
  const authEnabled = yield* resolveBoolOrFail(
    "auth.enabled",
    authRaw?.["enabled"],
    true,
    lookup,
    remoteWins("auth.enabled") ? undefined : envOverride("SUPABASE_AUTH_ENABLED"),
  );

  // Local helpers mirroring the deleted `legacyValidateAuthConfig`'s closures — its Go-parity
  // CHECKS now live in `legacyValidateResolvedConfig`; `str`/`gate`/`fail` are still needed here
  // to build that call's `LegacyAuthInput`, and by the D-only sms/external checks below (never
  // part of the shared validator — see `legacy-config-validate.ts`'s module header).
  const fail = (message: string) => Effect.fail(new LegacyDbConfigLoadError({ message }));
  // Env-expanded string of `rec[key]` ("" when absent/non-string). An unresolved `env(VAR)`
  // stays literal (non-empty), matching Go's LoadEnvHook + the Secret decode hook.
  const str = (rec: RawDoc | undefined, key: string): string => {
    const value = rec?.[key];
    return typeof value === "string" ? legacyExpandEnv(value, lookup) : "";
  };
  // Weak-bool decode (Go mapstructure): boolean | nonzero number | strconv.ParseBool string. A
  // malformed string ABORTS the load like Go's decode (it does NOT coerce to false). Absent /
  // non-string → false (the default for every auth enable-flag).
  const gate = (rec: RawDoc | undefined, key: string, field: string) =>
    Effect.gen(function* () {
      const value = rec?.[key];
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      if (typeof value !== "string") return false;
      const parsed = legacyParseGoBool(legacyExpandEnv(value, lookup));
      if (parsed === undefined) return yield* fail(`failed to parse config: invalid ${field}.`);
      return parsed;
    });

  const authRawResolved = authRaw ?? {};
  let authInput: LegacyAuthInput | undefined;
  if (authEnabled) {
    // A1: site_url required.
    const siteUrl =
      authRawResolved["site_url"] === undefined
        ? DEFAULT_AUTH_SITE_URL
        : str(authRawResolved, "site_url");

    // A4: [auth.captcha]. The provider enum check and the `enabled`-gated
    // required-field checks both live in `legacyValidateResolvedConfig`.
    const captchaRaw = asRecord(authRawResolved["captcha"]);
    let captchaInput: LegacyCaptchaInput | undefined;
    if (captchaRaw !== undefined) {
      const provider = str(captchaRaw, "provider");
      const secret = str(captchaRaw, "secret");
      captchaInput = {
        enabled: yield* gate(captchaRaw, "enabled", "auth.captcha.enabled"),
        // `str()` returns `""` for an absent key, but the shared validator's
        // `provider === undefined` check needs a real `undefined` to fire correctly for an
        // enabled captcha with no provider set.
        provider: provider.length > 0 ? provider : undefined,
        secret: secret.length > 0 ? secret : undefined,
      };
    }

    // A5: signing keys file load — I/O, stays in D. A relative path
    // resolves under the supabase dir; absolute is verbatim.
    const signingKeysPath = str(authRawResolved, "signing_keys_path");
    if (signingKeysPath.length > 0) {
      const keysJson = yield* fs
        .readFileString(legacyResolveSigningKeysPath(workdir, signingKeysPath))
        .pipe(
          Effect.mapError(
            (cause) =>
              new LegacyDbConfigLoadError({ message: legacySigningKeysReadErrorMessage(cause) }),
          ),
        );
      yield* Effect.try({
        try: () => {
          const parsed: unknown = JSON.parse(keysJson);
          if (!Array.isArray(parsed)) {
            throw new Error("signing keys must be a JSON array of JWKs");
          }
          return parsed;
        },
        catch: (cause) =>
          new LegacyDbConfigLoadError({ message: legacySigningKeysDecodeErrorMessage(cause) }),
      });
    }

    // A6: passkey/webauthn when passkey enabled.
    const passkeyRaw = asRecord(authRawResolved["passkey"]);
    let passkeyInput: LegacyPasskeyInput | undefined;
    if (passkeyRaw !== undefined && (yield* gate(passkeyRaw, "enabled", "auth.passkey.enabled"))) {
      const webauthnRaw = asRecord(authRawResolved["webauthn"]);
      const rpOriginsRaw = webauthnRaw?.["rp_origins"];
      // Go decodes `rp_origins` (a `[]string`) through the same
      // `StringToSliceHookFunc(",")` mapstructure hook as every other `[]string` field —
      // a raw or `env(...)`-resolved comma-separated string must be
      // split, not treated as "missing" just because it isn't already a literal TOML array.
      // Matches `legacy-local-config-values.ts`'s own `legacyResolveGotruePasskeyWebauthn`/
      // `legacyStrToArr` handling of this identical field.
      const rpOrigins = Array.isArray(rpOriginsRaw)
        ? rpOriginsRaw
        : legacyStrToArr(str(webauthnRaw, "rp_origins"));
      passkeyInput = {
        webauthnPresent: webauthnRaw !== undefined,
        rpId: str(webauthnRaw, "rp_id"),
        rpOrigins: rpOrigins.length > 0 ? rpOrigins : undefined,
      };
    }

    // B1: hooks — each enabled hook, Go's fixed iteration order.
    const hookRaw = asRecord(authRawResolved["hook"]);
    const hookTypes = [
      "mfa_verification_attempt",
      "password_verification_attempt",
      "custom_access_token",
      "send_sms",
      "send_email",
      "before_user_created",
    ] as const;
    const hooks: Array<LegacyHookInput> = [];
    for (const hookType of hookTypes) {
      const h = asRecord(hookRaw?.[hookType]);
      if (h !== undefined && (yield* gate(h, "enabled", `auth.hook.${hookType}.enabled`))) {
        hooks.push({ type: hookType, uri: str(h, "uri"), secrets: str(h, "secrets") });
      }
    }

    // B2: mfa — enroll requires verify, fixed totp/phone/web_authn order.
    const mfaRaw = asRecord(authRawResolved["mfa"]);
    const mfa: Array<LegacyMfaFactorInput> = [];
    for (const label of ["totp", "phone", "web_authn"] as const) {
      const factor = asRecord(mfaRaw?.[label]);
      mfa.push({
        label,
        enrollEnabled: yield* gate(factor, "enroll_enabled", `auth.mfa.${label}.enroll_enabled`),
        verifyEnabled: yield* gate(factor, "verify_enabled", `auth.mfa.${label}.verify_enabled`),
      });
    }

    // B3: email — template/notification content is I/O, stays in D. Config loading resolves
    // every relative `content_path` from the project root; absolute paths remain unchanged.
    const emailRaw = asRecord(authRawResolved["email"]);
    const templatesRaw = asRecord(emailRaw?.["template"]);
    if (templatesRaw !== undefined) {
      for (const name of Object.keys(templatesRaw)) {
        const tmpl = asRecord(templatesRaw[name]);
        if (tmpl === undefined) continue;
        const contentPath = yield* Effect.try({
          try: () =>
            legacyResolveEmailTemplateContentPath({
              section: "template",
              name,
              contentPath: str(tmpl, "content_path"),
              contentPresent: tmpl["content"] !== undefined,
              base: workdir,
            }),
          catch: (cause) =>
            new LegacyDbConfigLoadError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        if (contentPath === undefined) continue;
        yield* fs.readFileString(contentPath).pipe(
          Effect.mapError(
            (cause) =>
              new LegacyDbConfigLoadError({
                message: legacyEmailContentPathReadErrorMessage("template", name, cause),
              }),
          ),
        );
      }
    }
    const notificationsRaw = asRecord(emailRaw?.["notification"]);
    if (notificationsRaw !== undefined) {
      for (const name of Object.keys(notificationsRaw)) {
        const tmpl = asRecord(notificationsRaw[name]);
        if (
          tmpl === undefined ||
          !(yield* gate(tmpl, "enabled", `auth.email.notification.${name}.enabled`))
        ) {
          continue;
        }
        const contentPath = yield* Effect.try({
          try: () =>
            legacyResolveEmailTemplateContentPath({
              section: "notification",
              name,
              contentPath: str(tmpl, "content_path"),
              contentPresent: tmpl["content"] !== undefined,
              base: workdir,
            }),
          catch: (cause) =>
            new LegacyDbConfigLoadError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        if (contentPath === undefined) continue;
        yield* fs.readFileString(contentPath).pipe(
          Effect.mapError(
            (cause) =>
              new LegacyDbConfigLoadError({
                message: legacyEmailContentPathReadErrorMessage("notification", name, cause),
              }),
          ),
        );
      }
    }
    // Go defaults `auth.email.smtp.enabled = true` when the `[auth.email.smtp]` table is present
    // but omits `enabled`, so a present table validates unless explicitly
    // disabled.
    const smtpRaw = asRecord(emailRaw?.["smtp"]);
    let smtpInput: LegacySmtpInput | undefined;
    if (smtpRaw !== undefined) {
      const smtpPortRaw = smtpRaw["port"];
      // The shared validator's required-field check is `port === 0` (Go decodes `port` into a
      // numeric type at the config-decode step, so it can never observe a non-numeric value here).
      // D reads the raw TOML/env string directly, so a non-numeric `port` (or an unresolved
      // `env(VAR)`) parses to `NaN` via `Number(...)` — normalize that to `0` so it still trips
      // the "missing required field" check instead of silently passing config load.
      const smtpPortNumeric =
        typeof smtpPortRaw === "number"
          ? smtpPortRaw
          : typeof smtpPortRaw === "string"
            ? Number(legacyExpandEnv(smtpPortRaw, lookup))
            : 0;
      smtpInput = {
        enabled:
          smtpRaw["enabled"] === undefined
            ? true
            : yield* gate(smtpRaw, "enabled", "auth.email.smtp.enabled"),
        host: str(smtpRaw, "host"),
        port: Number.isNaN(smtpPortNumeric) ? 0 : smtpPortNumeric,
        user: str(smtpRaw, "user"),
        pass: str(smtpRaw, "pass"),
        adminEmail: str(smtpRaw, "admin_email"),
      };
    }

    // B6: third_party — each enabled provider, Go's fixed order. Note
    // `aws_cognito`'s messages say `cognito` (Go's wording).
    const thirdPartyRaw = asRecord(authRawResolved["third_party"]);
    const thirdParty: Array<LegacyThirdPartyInput> = [];
    const firebaseRaw = asRecord(thirdPartyRaw?.["firebase"]);
    if (
      firebaseRaw !== undefined &&
      (yield* gate(firebaseRaw, "enabled", "auth.third_party.firebase.enabled"))
    ) {
      thirdParty.push({ provider: "firebase", requiredField: str(firebaseRaw, "project_id") });
    }
    const auth0Raw = asRecord(thirdPartyRaw?.["auth0"]);
    if (
      auth0Raw !== undefined &&
      (yield* gate(auth0Raw, "enabled", "auth.third_party.auth0.enabled"))
    ) {
      thirdParty.push({ provider: "auth0", requiredField: str(auth0Raw, "tenant") });
    }
    const cognitoRaw = asRecord(thirdPartyRaw?.["aws_cognito"]);
    if (
      cognitoRaw !== undefined &&
      (yield* gate(cognitoRaw, "enabled", "auth.third_party.aws_cognito.enabled"))
    ) {
      thirdParty.push({
        provider: "cognito",
        requiredField: str(cognitoRaw, "user_pool_id"),
        cognitoUserPoolRegion: str(cognitoRaw, "user_pool_region"),
      });
    }
    const clerkRaw = asRecord(thirdPartyRaw?.["clerk"]);
    if (
      clerkRaw !== undefined &&
      (yield* gate(clerkRaw, "enabled", "auth.third_party.clerk.enabled"))
    ) {
      thirdParty.push({ provider: "clerk", requiredField: str(clerkRaw, "domain") });
    }
    const workosRaw = asRecord(thirdPartyRaw?.["workos"]);
    if (
      workosRaw !== undefined &&
      (yield* gate(workosRaw, "enabled", "auth.third_party.workos.enabled"))
    ) {
      thirdParty.push({ provider: "workos", requiredField: str(workosRaw, "issuer_url") });
    }

    authInput = {
      siteUrl,
      captcha: captchaInput,
      passkey: passkeyInput,
      hooks,
      mfa,
      smtp: smtpInput,
      thirdParty,
    };
  }

  // Go's config.Validate validates `[analytics]` after the auth block.
  // Computed here (after the auth block, before the single shared call) rather than pure-derived
  // earlier: `analyticsEnabled` resolves through `resolveBoolOrFail`, which can itself FAIL on a
  // malformed `SUPABASE_ANALYTICS_ENABLED`/`analytics.enabled` bool — positioning that failure
  // point ahead of the auth block would report it before an auth-block error even for a config
  // that's ALSO broken there, reversing Go's real order. Go merges the template defaults
  // `enabled = true`, `backend = "postgres"` before Validate (`templates/config.toml:388-392`), so
  // an absent `[analytics]` section is enabled+postgres and passes (an empty backend never equals
  // `bigquery`, so the GCP block is skipped). viper AutomaticEnv binds `SUPABASE_ANALYTICS_*`; a
  // matched remote block makes those keys env-immune, same as every other
  // `LEGACY_ENV_OVERRIDABLE_KEYS` field above.
  const analyticsString = (
    key: "backend" | "gcp_project_id" | "gcp_project_number" | "gcp_jwt_path",
    envName: string,
  ): string => {
    const fromEnv = remoteWins(`analytics.${key}`) ? undefined : envOverride(envName);
    const raw = fromEnv ?? analyticsRaw?.[key];
    return typeof raw === "string" ? legacyExpandEnv(raw, lookup) : "";
  };
  const analyticsBackend = analyticsString("backend", "SUPABASE_ANALYTICS_BACKEND");
  const analyticsEnabled = yield* resolveBoolOrFail(
    "analytics.enabled",
    analyticsRaw?.["enabled"],
    true,
    lookup,
    remoteWins("analytics.enabled") ? undefined : envOverride("SUPABASE_ANALYTICS_ENABLED"),
  );
  // Each GCP value is env-expanded (Go's LoadEnvHook), so an unresolved `env(VAR)` stays
  // non-empty and passes the shared validator's `length === 0` check, exactly like Go.
  const gcpProjectId = analyticsString("gcp_project_id", "SUPABASE_ANALYTICS_GCP_PROJECT_ID");
  const gcpProjectNumber = analyticsString(
    "gcp_project_number",
    "SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER",
  );
  const gcpJwtPath = analyticsString("gcp_jwt_path", "SUPABASE_ANALYTICS_GCP_JWT_PATH");

  // Every PURE Config.Validate check this module/legacy-config-validate.ts jointly own (db.port
  // is checked earlier, above, and stays there — see the comment at that check) is deferred to
  // this single call, in Go's exact relative order. D's sms/external checks (D-only, never part
  // of the shared validator) run AFTER this call succeeds, still gated on `authEnabled` — see
  // `legacy-config-validate.ts`'s module header for the accepted ordering tradeoff this
  // introduces against third_party.
  const dbInput: LegacyDbInput = { port, majorVersion };
  const analyticsInput: LegacyAnalyticsInput = {
    enabled: analyticsEnabled,
    backend: analyticsBackend.length > 0 ? analyticsBackend : undefined,
    gcpProjectId,
    gcpProjectNumber,
    gcpJwtPath,
  };
  const experimentalInput: LegacyExperimentalInput = {
    webhooksPresent,
    webhooksEnabled,
    pgdeltaFormatOptions: formatOptionsExpanded,
  };
  const validationInput: LegacyConfigValidationInput = {
    db: dbInput,
    storageBucketNames: bucketsRaw !== undefined ? Object.keys(bucketsRaw) : [],
    functionSlugs: functionsRaw !== undefined ? Object.keys(functionsRaw) : [],
    auth: authInput,
    edgeRuntimeDenoVersion: denoVersion,
    analytics: analyticsInput,
    experimental: experimentalInput,
  };
  yield* Effect.try({
    try: () => legacyValidateResolvedConfig(validationInput),
    catch: (cause) =>
      new LegacyDbConfigLoadError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

  if (authEnabled) {
    // B4: sms — D-only (never part of the shared validator, see
    // `legacy-config-validate.ts`'s module header). Only the FIRST enabled provider is
    // validated.
    const sms = asRecord(authRawResolved["sms"]);
    if (sms !== undefined) {
      const twilio = asRecord(sms["twilio"]);
      const twilioVerify = asRecord(sms["twilio_verify"]);
      const messagebird = asRecord(sms["messagebird"]);
      const textlocal = asRecord(sms["textlocal"]);
      const vonage = asRecord(sms["vonage"]);
      const twilioEnabled = yield* gate(twilio, "enabled", "auth.sms.twilio.enabled");
      const twilioVerifyEnabled = yield* gate(
        twilioVerify,
        "enabled",
        "auth.sms.twilio_verify.enabled",
      );
      const messagebirdEnabled = yield* gate(
        messagebird,
        "enabled",
        "auth.sms.messagebird.enabled",
      );
      const textlocalEnabled = yield* gate(textlocal, "enabled", "auth.sms.textlocal.enabled");
      const vonageEnabled = yield* gate(vonage, "enabled", "auth.sms.vonage.enabled");
      if (twilioEnabled) {
        if (str(twilio, "account_sid").length === 0)
          return yield* fail("Missing required field in config: auth.sms.twilio.account_sid");
        if (str(twilio, "message_service_sid").length === 0)
          return yield* fail(
            "Missing required field in config: auth.sms.twilio.message_service_sid",
          );
        if (str(twilio, "auth_token").length === 0)
          return yield* fail("Missing required field in config: auth.sms.twilio.auth_token");
      } else if (twilioVerifyEnabled) {
        if (str(twilioVerify, "account_sid").length === 0)
          return yield* fail(
            "Missing required field in config: auth.sms.twilio_verify.account_sid",
          );
        if (str(twilioVerify, "message_service_sid").length === 0)
          return yield* fail(
            "Missing required field in config: auth.sms.twilio_verify.message_service_sid",
          );
        if (str(twilioVerify, "auth_token").length === 0)
          return yield* fail("Missing required field in config: auth.sms.twilio_verify.auth_token");
      } else if (messagebirdEnabled) {
        if (str(messagebird, "originator").length === 0)
          return yield* fail("Missing required field in config: auth.sms.messagebird.originator");
        if (str(messagebird, "access_key").length === 0)
          return yield* fail("Missing required field in config: auth.sms.messagebird.access_key");
      } else if (textlocalEnabled) {
        if (str(textlocal, "sender").length === 0)
          return yield* fail("Missing required field in config: auth.sms.textlocal.sender");
        if (str(textlocal, "api_key").length === 0)
          return yield* fail("Missing required field in config: auth.sms.textlocal.api_key");
      } else if (vonageEnabled) {
        if (str(vonage, "from").length === 0)
          return yield* fail("Missing required field in config: auth.sms.vonage.from");
        if (str(vonage, "api_key").length === 0)
          return yield* fail("Missing required field in config: auth.sms.vonage.api_key");
        if (str(vonage, "api_secret").length === 0)
          return yield* fail("Missing required field in config: auth.sms.vonage.api_secret");
      }
    }

    // B5: external providers — D-only (never part of the shared validator). linkedin/slack
    // are deprecated and deleted before validation, so they are never validated here.
    const external = asRecord(authRawResolved["external"]);
    if (external !== undefined) {
      for (const name of Object.keys(external)) {
        if (name === "linkedin" || name === "slack") continue;
        const provider = asRecord(external[name]);
        if (provider === undefined) continue;
        if (!(yield* gate(provider, "enabled", `auth.external.${name}.enabled`))) continue;
        if (str(provider, "client_id").length === 0)
          return yield* fail(`Missing required field in config: auth.external.${name}.client_id`);
        if (name !== "apple" && name !== "google" && str(provider, "secret").length === 0)
          return yield* fail(`Missing required field in config: auth.external.${name}.secret`);
      }
    }
  }

  // `[db.vault]` secret names, sorted (`setupInputsToken` sorts before hashing).
  const vaultRaw = asRecord(db?.["vault"]);
  const vaultNames = vaultRaw === undefined ? [] : Object.keys(vaultRaw).sort();

  // `[db.migrations] enabled` — default true; overridable by
  // `SUPABASE_DB_MIGRATIONS_ENABLED` — EXCEPT when the matched remote block explicitly
  // set it (then the remote override-tier value wins).
  const migrationsRaw = asRecord(db?.["migrations"]);
  const migrationsEnabled = yield* resolveBoolOrFail(
    "db.migrations.enabled",
    migrationsRaw?.["enabled"],
    true,
    lookup,
    remoteWins("db.migrations.enabled") ? undefined : envOverride("SUPABASE_DB_MIGRATIONS_ENABLED"),
  );
  // `[db.seed]` — Go defaults enabled true, sql_paths ["seed.sql"]; relative
  // patterns are supabase-prefixed. `db.seed.enabled` is
  // overridable by `SUPABASE_DB_SEED_ENABLED` via viper AutomaticEnv — EXCEPT when a
  // matched remote block supplied it at the override tier (set or forced false).
  const seedRaw = asRecord(db?.["seed"]);
  const seedEnabled = yield* resolveBoolOrFail(
    "db.seed.enabled",
    seedRaw?.["enabled"],
    true,
    lookup,
    remoteWins("db.seed.enabled") ? undefined : envOverride("SUPABASE_DB_SEED_ENABLED"),
  );
  // `db.seed.sql_paths` decodes through the hook chain in order: `env(VAR)` expansion
  // runs BEFORE the comma-split. So a STRING value — the `SUPABASE_DB_SEED_SQL_PATHS`
  // env override or a TOML string — is env-expanded FIRST, then comma-split (no
  // trimming; empty → `[]`). A TOML ARRAY is decoded element-by-element: each element is
  // env-expanded but NOT re-split, so `["env(SEEDS)"]` stays one pattern. The env
  // override (non-empty; `envOverride` drops empties) wins over the TOML value; an
  // absent (or non-string/non-array) value falls back to the `["seed.sql"]` default.
  const splitGoSeedPaths = (value: string): ReadonlyArray<string> => {
    const expanded = legacyExpandEnv(value, lookup);
    return expanded.length === 0 ? [] : expanded.split(",");
  };
  // A weakly-converted float renders via `strconv.FormatFloat(v, 'f', -1, 64)` — ALWAYS
  // fixed decimal notation, never scientific, regardless of magnitude. JS's
  // `String(value)` agrees for ordinary magnitudes (both use the same
  // shortest-round-trip digit sequence — `String()` just chooses "e" notation once
  // `|value| >= 1e21` or `< 1e-6`, which `FormatFloat('f', …)` never does). Verified
  // empirically: `strconv.FormatFloat(1e21, 'f', -1, 64)` returns
  // `"1000000000000000000000"`, not `"1e+21"`. Expand JS's own exponential notation
  // back into fixed notation instead of re-deriving the digits, since
  // `Number.prototype.toString()`/`toExponential()` already computed the same shortest
  // round-tripping digit sequence the Go algorithm would — only the notation differs.
  //
  // `strconv.FormatFloat` special-cases the three non-finite values BEFORE it ever
  // looks at the format verb, so `'f'` never applies to them: verified empirically
  // (a probe against a real `schema_paths = [inf, -inf, nan]` config load) —
  // `+Inf`/`-Inf`/`NaN` (note the "+Inf" sign Go always prints, and the short "Inf"/"NaN"
  // spelling) — never JS's own `Infinity`/`-Infinity`/`NaN` (which happens to already
  // match the "NaN" case, but not the two `Infinity` ones). TOML v1.0's bare `inf`/
  // `+inf`/`-inf`/`nan` float literals (smol-toml) parse to exactly these JS values, so
  // a `schema_paths`/`sql_paths` array entry can realistically hit this branch.
  //
  // `strconv.FormatFloat` also preserves the IEEE754 sign bit on zero: a genuine
  // negative-zero float64 formats as `"-0"`, never `"0"`. Verified empirically —
  // `strconv.FormatFloat(math.Copysign(0, -1), 'f', -1, 64)` returns `"-0"` — and
  // end-to-end through the real decode pipeline this weak-decode mirrors
  // (`BurntSushi/toml` + `mapstructure`'s weakly-typed input): a `schema_paths =
  // [-0.0]` config decodes its glob entry to the literal string `"-0"`. JS's own
  // `(-0).toString()` is `"0"` (the sign is dropped), by spec — `Object.is(value, -0)`
  // is JS's only way to detect it, since `-0 === 0`.
  const legacyFormatGoWeakFloat = (value: number): string => {
    if (Number.isNaN(value)) return "NaN";
    if (value === Number.POSITIVE_INFINITY) return "+Inf";
    if (value === Number.NEGATIVE_INFINITY) return "-Inf";
    if (Object.is(value, -0)) return "-0";
    const str = value.toString();
    const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(str);
    if (match === null) return str;
    const [, sign = "", intPart = "", fracPart = "", expStr = "0"] = match;
    const digits = intPart + fracPart;
    const pointPos = intPart.length + Number(expStr);
    if (pointPos <= 0) return `${sign}0.${"0".repeat(-pointPos)}${digits}`;
    if (pointPos >= digits.length) return `${sign}${digits}${"0".repeat(pointPos - digits.length)}`;
    return `${sign}${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  };
  // Go decodes both `[db.seed].sql_paths` and `[db.migrations].schema_paths` as
  // `config.Glob` (`[]string`) through the SAME mapstructure `UnmarshalExact` call,
  // whose decoder config never sets `WeaklyTypedInput: false` —
  // viper's `defaultDecoderConfig` defaults it to `true` and nothing here overrides
  // it. So a non-string array element isn't dropped: `decodeString`
  // weakly
  // converts a bool to `"1"`/`"0"` and a number to its decimal string, THEN the
  // result flows through the same env-expand/resolve pipeline as a real string
  // entry. Verified empirically (`schema_paths = [42]` resolves to `supabase/42`,
  // `schema_paths = [true]` to `supabase/1`).
  const legacyWeakCoerceGlobEntry = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (typeof value === "boolean") return value ? "1" : "0";
    if (typeof value === "number") return legacyFormatGoWeakFloat(value);
    return undefined;
  };
  // A non-scalar element (nested array/table, e.g. `schema_paths = [[]]` or
  // `[{path = "x.sql"}]`) is mapstructure's `UnconvertibleTypeError` instead of a weak
  // conversion, and mapstructure reports every offending index from the SAME
  // `UnmarshalExact` call together, joined by its own `Error.Error()` — which is what
  // aborts the entire config load, not just that one array. Verified empirically:
  // `schema_paths = [[]]` / `[{path = "x.sql"}]` both fail with
  // `failed to parse config: decoding failed due to the following error(s):\n\n'db.
  // migrations.schema_paths[0]' expected type 'string', got unconvertible type
  // '[]interface {}'` / `'map[string]interface {}'` respectively — never silently
  // dropping the element and continuing with an empty/partial glob list.
  //
  // A bare TOML datetime (e.g. `schema_paths = 1979-05-27T07:32:00Z`) hits this same
  // `UnconvertibleTypeError` path, but as a DIFFERENT Go type per TOML datetime
  // variant — `BurntSushi/toml` decodes an offset date-time to stdlib `time.Time` and
  // each of the 3 zone-less "local" variants to its own `toml.Local*` wrapper type.
  // Verified empirically (review CLI-1958): `schema_paths = 1979-05-27T07:32:00Z` →
  // `unconvertible type
  // 'time.Time'`; `= 1979-05-27T07:32:00` (no zone) → `'toml.LocalDateTime'`;
  // `= 1979-05-27` → `'toml.LocalDate'`; `= 07:32:00` → `'toml.LocalTime'` — same four
  // messages whether the datetime is this top-level scalar or an array element.
  // `smol-toml` parses every TOML datetime to a `TomlDate` (a `Date` subclass, so
  // `typeof`/`Array.isArray` alone can't tell it apart from an inline table) exposing
  // exactly the `isDate`/`isTime`/`isDateTime`/`isLocal` discriminators needed to
  // reproduce Go's per-variant type name.
  const legacyGoTomlDateType = (value: SmolToml.TomlDate): string => {
    if (value.isDate()) return "toml.LocalDate";
    if (value.isTime()) return "toml.LocalTime";
    return value.isLocal() ? "toml.LocalDateTime" : "time.Time";
  };
  const legacyGoUnconvertibleType = (value: unknown): string | undefined =>
    value instanceof SmolToml.TomlDate
      ? legacyGoTomlDateType(value)
      : Array.isArray(value)
        ? "[]interface {}"
        : typeof value === "object" && value !== null
          ? "map[string]interface {}"
          : undefined;
  // Pure — returns the mapstructure-style issue strings for a real `Glob` array's
  // unconvertible elements WITHOUT failing. `UnmarshalExact` decodes the WHOLE
  // config in a SINGLE mapstructure pass: `decodeStructFromMap`'s per-field loop
  // appends each field's decode error to a shared `errs`
  // slice and keeps going — it never stops at the first field's error — then
  // `errors.Join(errs...)`-s everything together at the very end.
  // So an invalid `db.migrations.schema_paths` does NOT
  // prevent `db.seed.sql_paths` from ALSO being decoded (and erroring) in the same
  // pass; both surface together in ONE combined error. Verified empirically (both
  // fields containing an unconvertible entry, e.g. `sql_paths = [[]]` +
  // `schema_paths = [[]]`): the single returned error
  // contains BOTH lines, `db.migrations.schema_paths[0]` BEFORE `db.seed.sql_paths[0]` —
  // `db` struct declares `Migrations` before `Seed`,
  // and mapstructure iterates struct fields in declaration order, not alphabetically,
  // so callers below must combine in that same order before failing once (see
  // `legacyFailOnGlobIssues`).
  const legacyGlobArrayIssues = (
    keyPath: string,
    values: ReadonlyArray<unknown>,
  ): ReadonlyArray<string> =>
    values.flatMap((value, index) => {
      const goType = legacyGoUnconvertibleType(value);
      return goType === undefined
        ? []
        : [`'${keyPath}[${index}]' expected type 'string', got unconvertible type '${goType}'`];
    });
  // Fails ONCE with every issue collected across BOTH `Glob` fields (see
  // `legacyGlobArrayIssues`'s doc comment) — never called per-field, so a config
  // invalid in both `db.seed.sql_paths` and `db.migrations.schema_paths` reports both,
  // matching Go's single combined `UnmarshalExact` error instead of only the first
  // field checked.
  const legacyFailOnGlobIssues = (
    issues: ReadonlyArray<string>,
  ): Effect.Effect<void, LegacyDbConfigLoadError> =>
    issues.length === 0
      ? Effect.void
      : fail(
          `failed to parse config: decoding failed due to the following error(s):\n\n${issues.join("\n")}`,
        );
  // A TOP-LEVEL raw value that is neither an array nor a string (e.g.
  // `schema_paths = 42`/`true`, or a stray inline table) still reaches
  // mapstructure's `decodeSlice`, which is weakly typed the same way an array
  // ELEMENT is (see `legacyWeakCoerceGlobEntry` above): a zero-length map
  // decodes straight to an empty slice; anything else is wrapped into a
  // synthetic single-element `[]any{value}` and decoded through the exact
  // same per-element rules as a real array entry — a scalar weakly coerces,
  // an unconvertible value (map/array) fails with `'<keyPath>[0]' expected
  // type 'string', got unconvertible type '...'` (mapstructure always
  // reports the synthetic wrapped index, which is `0`). Verified empirically:
  // `schema_paths = 42` → `["42"]`, `= true` →
  // `["1"]`, `= {}` → `[]`, `[db.migrations.schema_paths]\nfoo = "bar"` →
  // `failed to parse config: … 'db.migrations.schema_paths[0]' expected type
  // 'string', got unconvertible type 'map[string]interface {}'`. Never
  // called with `undefined` — an absent key has its own default per caller
  // below, so callers guard that case before reaching here.
  //
  // The zero-length-map special case must NOT match a `TomlDate` (e.g. `schema_paths =
  // 1979-05-27T07:32:00Z`): a `TomlDate` stores its value internally, not as an
  // enumerable own property, so `Object.keys(tomlDate).length === 0` is ALSO true for
  // it — but Go does not treat a bare datetime as an empty map; mapstructure reports it
  // unconvertible and aborts the whole load (see `legacyGoUnconvertibleType` above).
  // Without this exclusion, a `TomlDate` would silently resolve to `[]` here instead of
  // falling through to the unconvertible-type issue below, turning Go's hard config-load
  // failure into a silently-empty schema/seed path list (review CLI-1958).
  // Pure — the TOP-LEVEL scalar fallback (see doc comment above), returning either the
  // one resolved pattern or the one issue it would raise, WITHOUT failing (same reason
  // as `legacyGlobArrayIssues`: the caller combines issues across both `Glob` fields
  // before deciding whether to fail).
  const legacyResolveScalarGlobFallback = (
    keyPath: string,
    value: unknown,
  ): { readonly resolved: ReadonlyArray<string>; readonly issues: ReadonlyArray<string> } => {
    if (
      typeof value === "object" &&
      value !== null &&
      !(value instanceof SmolToml.TomlDate) &&
      Object.keys(value).length === 0
    ) {
      return { resolved: [], issues: [] };
    }
    const coerced = legacyWeakCoerceGlobEntry(value);
    if (coerced !== undefined) {
      return { resolved: [coerced], issues: [] };
    }
    return { resolved: [], issues: legacyGlobArrayIssues(keyPath, [value]) };
  };
  /**
   * Resolves ONE `Glob`-typed field (`[db.seed].sql_paths` / `[db.migrations].
   * schema_paths`) into its pre-supabase-join patterns, covering every decode branch
   * in one place: override env var, real array, bare string, absent key (caller's own
   * Go-matching default), or the top-level scalar fallback. Returns any issues
   * alongside the best-effort patterns rather than failing here — see
   * `legacyFailOnGlobIssues`'s doc comment for why the two `Glob` fields must combine
   * their issues into ONE error before failing, matching Go's single `UnmarshalExact`
   * pass, instead of each field failing independently on its own first bad entry.
   */
  const legacyResolveGlobField = (
    keyPath: string,
    raw: unknown,
    override: string | undefined,
    absentDefault: ReadonlyArray<string>,
  ): { readonly patterns: ReadonlyArray<string>; readonly issues: ReadonlyArray<string> } => {
    if (override !== undefined) {
      return { patterns: splitGoSeedPaths(override), issues: [] };
    }
    if (Array.isArray(raw)) {
      return {
        patterns: raw
          .map((pattern) => legacyWeakCoerceGlobEntry(pattern))
          .filter((pattern): pattern is string => pattern !== undefined)
          .map((pattern) => legacyExpandEnv(pattern, lookup)),
        issues: legacyGlobArrayIssues(keyPath, raw),
      };
    }
    if (typeof raw === "string") {
      return { patterns: splitGoSeedPaths(raw), issues: [] };
    }
    if (raw === undefined) {
      return { patterns: absentDefault, issues: [] };
    }
    const fallback = legacyResolveScalarGlobFallback(keyPath, raw);
    return {
      patterns: fallback.resolved.map((pattern) => legacyExpandEnv(pattern, lookup)),
      issues: fallback.issues,
    };
  };
  const rawSqlPaths = seedRaw?.["sql_paths"];
  const sqlPathsOverride = remoteWins("db.seed.sql_paths")
    ? undefined
    : envOverride("SUPABASE_DB_SEED_SQL_PATHS");
  const sqlPathsResolved = legacyResolveGlobField(
    "db.seed.sql_paths",
    rawSqlPaths,
    sqlPathsOverride,
    ["seed.sql"],
  );
  // Patterns are already env-expanded above (expansion runs before the split); resolve
  // each to its config-load form (absolute verbatim, relative supabase-joined).
  const seedSqlPaths = sqlPathsResolved.patterns.map((pattern) =>
    legacyResolveSeedSqlPath(path, pattern),
  );

  // `[db.migrations] schema_paths` — default `[]`, resolved through the exact same
  // decode + env-expand + supabase-join pipeline as `[db.seed].sql_paths` above, but
  // UNCONDITIONALLY (the resolve loop for schema_paths is not gated on
  // `db.migrations.enabled` the way the seed loop is gated on `db.seed.enabled`).
  const rawSchemaPaths = migrationsRaw?.["schema_paths"];
  const schemaPathsOverride = remoteOverrideKeys.has("db.migrations.schema_paths")
    ? undefined
    : envOverride("SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS");
  const schemaPathsResolved = legacyResolveGlobField(
    "db.migrations.schema_paths",
    rawSchemaPaths,
    schemaPathsOverride,
    [],
  );

  // The whole config decodes in ONE pass (see `legacyGlobArrayIssues`'s doc comment) —
  // combine BOTH `Glob` fields' issues, in struct-declaration order (`Migrations`
  // before `Seed`), before failing once, so a config invalid in both surfaces both
  // in a single combined error instead of only the first field checked.
  yield* legacyFailOnGlobIssues([...schemaPathsResolved.issues, ...sqlPathsResolved.issues]);

  const schemaPaths = schemaPathsResolved.patterns.map((pattern) =>
    legacyResolveSeedSqlPath(path, pattern),
  );

  // `[db.vault]` secrets: env-expand each value, then decrypt dotenvx `encrypted:`
  // ciphertext. `resolved` gates on a successful decrypt-or-passthrough (`UpsertVaultSecrets`
  // upserts only resolved secrets). An `encrypted:` value that cannot be decrypted
  // aborts the command with `failed to parse config: <error>` — it is never silently
  // skipped, which an earlier port did.
  const vault: Array<LegacyDbVaultSecretToml> = [];
  if (resolveVaultSecrets && vaultRaw !== undefined) {
    for (const name of Object.keys(vaultRaw).sort()) {
      const raw = vaultRaw[name];
      const value = typeof raw === "string" ? legacyExpandEnv(raw, lookup) : "";
      // Empty or an unexpanded `env(...)` reference → unresolved (Go returns these
      // verbatim from the hook without hashing, so SHA256 stays empty).
      if (value.length === 0 || ENV_PATTERN.test(value)) {
        vault.push({ name, value, resolved: false });
        continue;
      }
      if (legacyIsEncryptedSecret(value)) {
        const decrypted = legacyDecryptSecret(value, dotenvPrivateKeys);
        if (!decrypted.ok) {
          return yield* Effect.fail(
            new LegacyDbConfigLoadError({ message: `failed to parse config: ${decrypted.error}` }),
          );
        }
        vault.push({ name, value: decrypted.value, resolved: true });
        continue;
      }
      vault.push({ name, value, resolved: true });
    }
  }

  // `[api] auto_expose_new_tables` is a tri-state `*bool`:
  // present → Some(bool), absent → None (never false). Go applies the
  // `SUPABASE_API_AUTO_EXPOSE_NEW_TABLES` AutomaticEnv override and decodes the value
  // with `strconv.ParseBool`, failing the load on a malformed value — so `1`/`TRUE`/
  // `env(...)` parse correctly and `maybe` aborts rather than silently coercing to false.
  const apiAutoExposeNewTables = yield* resolveOptionalBoolOrFail(
    "api.auto_expose_new_tables",
    remoteWins("api.auto_expose_new_tables")
      ? undefined
      : envOverride("SUPABASE_API_AUTO_EXPOSE_NEW_TABLES"),
    apiRaw?.["auto_expose_new_tables"],
    lookup,
  );
  const apiSchemas = resolveStringSlice(
    (remoteWins("api.schemas") ? undefined : envOverride("SUPABASE_API_SCHEMAS")) ??
      apiRaw?.["schemas"],
    DEFAULT_API_SCHEMAS,
    lookup,
  );
  if (apiSchemas === undefined) {
    return yield* Effect.fail(
      new LegacyDbConfigLoadError({ message: "failed to parse config: invalid api.schemas." }),
    );
  }

  const values: LegacyDbTomlValues = {
    projectEnv,
    envLookup: envOverride,
    apiSchemas,
    port,
    shadowPort,
    password: passwordRaw !== undefined ? legacyExpandEnv(passwordRaw, lookup) : DEFAULT_PASSWORD,
    poolerConnectionString,
    projectId,
    majorVersion,
    orioledbVersion,
    denoVersion,
    pgDelta: {
      enabled,
      declarativeSchemaPath,
      formatOptions,
      npmVersion: pgDeltaNpmVersion,
    },
    webhooksEnabled,
    baseline: {
      authEnabled,
      storageEnabled: yield* resolveBoolOrFail(
        "storage.enabled",
        storageRaw?.["enabled"],
        true,
        lookup,
      ),
      realtimeEnabled: yield* resolveBoolOrFail(
        "realtime.enabled",
        realtimeRaw?.["enabled"],
        true,
        lookup,
      ),
      apiAutoExposeNewTables,
      vaultNames,
    },
    migrationsEnabled,
    schemaPaths,
    schemaPathPatterns: schemaPathsResolved.patterns,
    seed: { enabled: seedEnabled, sqlPaths: seedSqlPaths },
    vault,
    appliedRemote,
    remoteOverrideKeys,
  };
  return values;
});

/**
 * Read + validate `config.toml` exactly like `flags.LoadConfig` → `config.Load`
 * → `Validate`: an absent file yields defaults, but a present config that is
 * unreadable/malformed, references an undecryptable `encrypted:` secret, or fails any
 * of Go's decode/Validate checks (remote refs, `db.port`, `db.major_version`,
 * `edge_runtime.deno_version`, pgdelta gate, `format_options` JSON, bucket names,
 * function slugs, auth, analytics) aborts with the matching Go error. Call this at the
 * point Go fails fast — before asserting the stack is running, prompting, or any
 * destructive work — so a broken config never runs against the default local database.
 */
export const legacyCheckDbToml = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  ref?: string,
  // `warnOnUnresolvedEnv: false` — see `readDbTomlCore`'s own doc comment — for a
  // caller known to run AFTER an earlier, same-invocation `legacyCheckDbToml`/
  // `legacyReadDbToml` call already printed the OrioleDB S3 `assertEnvLoaded` WARN
  // once. Omit (default `true`) for every standalone command entry point.
  opts?: {
    readonly warnOnUnresolvedEnv?: boolean;
    /** Skip resolving `[db.vault]` values while validating the rest of the config. */
    readonly resolveVaultSecrets?: boolean;
  },
) =>
  readDbTomlCore(
    fs,
    path,
    workdir,
    ref,
    false,
    opts?.warnOnUnresolvedEnv ?? true,
    opts?.resolveVaultSecrets ?? true,
  );

/**
 * Read `config.toml`. Defaults to Go's validating behavior (identical to
 * {@link legacyCheckDbToml}); pass `{ validate: false }` for a best-effort read that
 * never throws on an invalid config — a config-load failure falls back to pure
 * defaults (env overrides still applied), matching the tolerant behavior the
 * container-id seam needs when it only wants `projectId` and the handler has already
 * validated the config. The throwing default keeps every existing caller at Go parity.
 */
export const legacyReadDbToml = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  ref?: string,
  opts?: {
    readonly validate?: boolean;
    readonly warnOnUnresolvedEnv?: boolean;
    readonly resolveVaultSecrets?: boolean;
  },
) => {
  const warnOnUnresolvedEnv = opts?.warnOnUnresolvedEnv ?? true;
  const resolveVaultSecrets = opts?.resolveVaultSecrets ?? true;
  return opts?.validate === false
    ? readDbTomlCore(fs, path, workdir, ref, false, warnOnUnresolvedEnv, resolveVaultSecrets).pipe(
        // Fall back to the ignore-file defaults path (never re-reads the broken config)
        // so a best-effort caller gets a well-formed defaults result instead of a throw.
        Effect.catchTag("LegacyDbConfigLoadError", () =>
          readDbTomlCore(fs, path, workdir, ref, true, warnOnUnresolvedEnv, resolveVaultSecrets),
        ),
      )
    : readDbTomlCore(fs, path, workdir, ref, false, warnOnUnresolvedEnv, resolveVaultSecrets);
};

/**
 * The effective declarative schema directory: the configured
 * `declarative_schema_path` (already `supabase/`-prefixed when relative) or the
 * default `supabase/schemas`. Mirrors `utils.GetDeclarativeDir`.
 * `path` joins the segments so
 * the separator matches the host platform, as `filepath.Join` does.
 */
export function legacyResolveDeclarativeDir(
  path: Path.Path,
  pgDelta: LegacyPgDeltaTomlConfig,
): string {
  return Option.getOrElse(pgDelta.declarativeSchemaPath, () =>
    path.join(...DEFAULT_DECLARATIVE_DIR_SEGMENTS),
  );
}
