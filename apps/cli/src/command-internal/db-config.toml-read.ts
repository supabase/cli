import { Effect, type FileSystem, Option, type Path } from "effect";
import * as SmolToml from "smol-toml";
import {
  PROJECT_REF_PATTERN,
  type AnalyticsInput,
  type AuthInput,
  type CaptchaInput,
  type ConfigValidationInput,
  type DbInput,
  emailContentPathReadErrorMessage,
  type ExperimentalInput,
  type HookInput,
  type MfaFactorInput,
  parseGoBool,
  type PasskeyInput,
  resolveEmailTemplateContentPath,
  resolveSigningKeysPath,
  signingKeysDecodeErrorMessage,
  signingKeysReadErrorMessage,
  type SmtpInput,
  type ThirdPartyInput,
  validateResolvedConfig,
} from "./config-validate.ts";
import { DbConfigLoadError } from "./db-config.errors.ts";
import { parseDotEnv } from "./dotenv.ts";
import { strToArr } from "./local-config-values.ts";
import { ramInBytes } from "./size-units.ts";
import { collectDotenvPrivateKeys, decryptSecret, isEncryptedSecret } from "./vault-decrypt.ts";

/** Resolves a config `env(VAR)` reference: shell env first, then project `.env`. */
type EnvLookup = (name: string) => string | undefined;

/**
 * Subset of `supabase/config.toml` (plus the linked pooler URL) the db-config
 * resolver needs. A missing config file yields defaults; a malformed one aborts
 * the command instead of running against the default local database.
 */
export interface DbTomlValues {
  readonly projectEnv: Readonly<Record<string, string>>;
  /**
   * Resolves a `SUPABASE_*` env var: shell env (non-empty) wins, then the
   * loaded project `.env*` files (non-empty), else `undefined`. Handlers must
   * call this rather than reading `process.env` directly.
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
   * Linked pooler connection string, used by the `--linked` pooler fallback.
   * Read from `supabase/.temp/pooler-url` (written by `supabase link`); not
   * part of the config schema.
   */
  readonly poolerConnectionString: Option.Option<string>;
  /** top-level `project_id`, used to name the local docker network. */
  readonly projectId: Option.Option<string>;
  /** `[db] major_version`, default 17. */
  readonly majorVersion: number;
  /**
   * `[experimental] orioledb_version` (env-expanded). Set on a 15/17 project to
   * rewrite the Postgres image to the OrioleDB tag; `None` for a vanilla project.
   */
  readonly orioledbVersion: Option.Option<string>;
  /**
   * `[edge_runtime] deno_version`, default 2. Selects the edge-runtime image tag:
   * `1` → the `deno1` image, otherwise the default.
   */
  readonly denoVersion: number;
  /**
   * `[experimental.pgdelta]` config, consumed by the declarative-schema commands
   * (`db schema declarative generate` / `sync`).
   */
  readonly pgDelta: PgDeltaTomlConfig;
  /** Effective `[experimental.webhooks].enabled`; false when the section is absent. */
  readonly webhooksEnabled: boolean;
  /**
   * The subset of config that shapes the shadow-database platform baseline and
   * therefore the declarative catalog-cache key (`setupInputsToken`). Drift in
   * any of these must self-invalidate cached catalogs.
   */
  readonly baseline: BaselineTomlConfig;
  /** `[db.migrations] enabled` (default true) — gates `up`/`down` migration apply. */
  readonly migrationsEnabled: boolean;
  /**
   * `[db.migrations] schema_paths`, default `[]` — resolved (supabase-prefixed
   * when relative) and overridable via `SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS`,
   * same as {@link DbSeedTomlConfig.sqlPaths}. Resolved unconditionally, not
   * gated on `migrationsEnabled`.
   */
  readonly schemaPaths: ReadonlyArray<string>;
  /**
   * `[db.migrations] schema_paths`, in raw (non-prefixed) form — the same
   * env/remote-override resolution as {@link schemaPaths}, but without the
   * `supabase/`-prefix join. Callers that join the prefix themselves (e.g.
   * shadow-provisioning) need this form to avoid double-joining a relative
   * pattern.
   */
  readonly schemaPathPatterns: ReadonlyArray<string>;
  /** `[db.seed]` enabled + supabase-prefixed `sql_paths` globs — used by `down`. */
  readonly seed: DbSeedTomlConfig;
  /** `[db.vault]` secrets (name → resolved value) — upserted by `up`/`down`. */
  readonly vault: ReadonlyArray<DbVaultSecretToml>;
  /**
   * The matched `[remotes.<name>]` block name when a linked ref merged its override
   * (`Loading config override: [remotes.<name>]` line), else `undefined`.
   */
  readonly appliedRemote: string | undefined;
  /**
   * The config keys the matched remote block contributed at override tier —
   * see {@link RemoteOverride.remoteOverrideKeys}. Exposed so a separate config
   * read for the same linked ref can apply the identical remote-over-env
   * precedence without re-deriving this set. Empty when no remote matched.
   */
  readonly remoteOverrideKeys: ReadonlySet<string>;
}

/** `[db.seed]` config surfaced for `migration down`'s seed step. */
interface DbSeedTomlConfig {
  readonly enabled: boolean;
  /** Glob patterns, each supabase-prefixed when relative. */
  readonly sqlPaths: ReadonlyArray<string>;
}

/**
 * A `[db.vault]` secret. `value` is the resolved plaintext (env-expanded, and
 * decrypted if it was a dotenvx `encrypted:` ciphertext). `resolved` is true
 * once the value is a non-empty, non-`env(...)` string.
 */
interface DbVaultSecretToml {
  readonly name: string;
  readonly value: string;
  readonly resolved: boolean;
}

/** Cache-key inputs from `[auth]`/`[storage]`/`[realtime]`/`[api]`/`[db.vault]`. */
interface BaselineTomlConfig {
  /** `[auth] enabled`, default true. Gates `initSchema`'s auth service migration. */
  readonly authEnabled: boolean;
  /** `[storage] enabled`, default true. */
  readonly storageEnabled: boolean;
  /** `[realtime] enabled`, default true. */
  readonly realtimeEnabled: boolean;
  /**
   * `[api] auto_expose_new_tables`, tri-state (`None` when unset). The cache
   * key folds in the effective bool — unset and `true` both mean grants are
   * kept.
   */
  readonly apiAutoExposeNewTables: Option.Option<boolean>;
  /** `[db.vault]` secret names (sorted), created during setup. */
  readonly vaultNames: ReadonlyArray<string>;
}

/** The `[experimental.pgdelta]` subtree. */
export interface PgDeltaTomlConfig {
  /** `[experimental.pgdelta] enabled`, default false. */
  readonly enabled: boolean;
  /**
   * `[experimental.pgdelta] declarative_schema_path`, resolved to a
   * `supabase/`-prefixed path when relative. `None` → callers use the default
   * `supabase/schemas` (`resolveDeclarativeDir`).
   */
  readonly declarativeSchemaPath: Option.Option<string>;
  /** `[experimental.pgdelta] format_options`, a JSON string passed to pg-delta. */
  readonly formatOptions: Option.Option<string>;
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
interface RemoteOverride {
  readonly doc: RawDoc | undefined;
  /**
   * The name of the matched `[remotes.<name>]` block whose `project_id` equals the
   * resolved ref, or `undefined` when no block matched. Callers echo the
   * `Loading config override: [remotes.<name>]` stderr line from this.
   */
  readonly appliedRemote?: string;
  /**
   * The config keys the matched remote block contributed at override tier;
   * each must outrank the matching `SUPABASE_*` env override. Holds every key
   * in {@link ENV_OVERRIDABLE_KEYS} the block supplies, plus `db.seed.enabled`
   * (always forced).
   */
  readonly remoteOverrideKeys: ReadonlySet<string>;
}

/**
 * The `project_id` of a `[remotes.<name>]` block for matching/duplicate
 * detection: `SUPABASE_REMOTES_<NAME>_PROJECT_ID` wins when non-empty, else
 * the raw (unexpanded) TOML literal. Validation instead uses the expanded
 * value — see {@link resolveValidatedRemoteProjectId}.
 */
function resolveRemoteProjectId(
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
 * The `project_id` of a `[remotes.<name>]` block for validation: the same
 * override precedence as {@link resolveRemoteProjectId}, but with `env(...)`
 * expanded (an unset `env(...)` stays literal and fails the ref pattern).
 */
function resolveValidatedRemoteProjectId(
  name: string,
  block: RawDoc | undefined,
  lookup: EnvLookup,
): string | undefined {
  const fromEnv = lookup(`SUPABASE_REMOTES_${name.toUpperCase()}_PROJECT_ID`);
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const literal = block?.["project_id"];
  return typeof literal === "string" ? expandEnv(literal, lookup) : undefined;
}

/**
 * Every dotted config key this reader resolves with a `SUPABASE_*` env override.
 * When a matched `[remotes.*]` block supplies any of these, the block value
 * must beat the matching env override.
 */
const ENV_OVERRIDABLE_KEYS = [
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
  "db.root_key",
  "api.port",
  "api.tls.enabled",
  "api.tls.cert_path",
  "api.tls.key_path",
  "api.external_url",
  "auth.jwt_secret",
  "auth.jwt_expiry",
  "auth.site_url",
  "auth.anon_key",
  "auth.service_role_key",
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
  "auth.jwt_issuer",
  "auth.additional_redirect_urls",
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
  "auth.mfa.phone.template",
  "auth.mfa.phone.max_frequency",
  "auth.captcha.enabled",
  "auth.captcha.provider",
  "auth.captcha.secret",
  "auth.email.smtp.enabled",
  "auth.email.smtp.port",
  "auth.email.smtp.pass",
  "auth.email.smtp.host",
  "auth.email.smtp.user",
  "auth.email.smtp.admin_email",
  "auth.email.smtp.sender_name",
  "auth.email.enable_signup",
  "auth.email.double_confirm_changes",
  "auth.email.enable_confirmations",
  "auth.email.secure_password_change",
  "auth.email.otp_length",
  "auth.email.otp_expiry",
  "auth.email.max_frequency",
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
  "auth.sms.twilio.account_sid",
  "auth.sms.twilio.message_service_sid",
  "auth.sms.twilio_verify.account_sid",
  "auth.sms.twilio_verify.message_service_sid",
  "auth.sms.messagebird.originator",
  "auth.sms.textlocal.sender",
  "auth.sms.vonage.from",
  "auth.sms.vonage.api_key",
  "auth.sms.template",
  "auth.sms.max_frequency",
  "auth.publishable_key",
  "auth.secret_key",
  "studio.openai_api_key",
  "studio.api_url",
] as const;

/**
 * `auth.external.<name>` is a map keyed by arbitrary provider name, so these
 * per-provider leaves can't be enumerated in {@link ENV_OVERRIDABLE_KEYS} —
 * {@link applyRemoteOverride} tracks them dynamically instead.
 */
const AUTH_EXTERNAL_PROVIDER_FIELDS = [
  "enabled",
  "client_id",
  "secret",
  "url",
  "redirect_uri",
  "skip_nonce_check",
  "email_optional",
] as const;

/**
 * `auth.email.template.<name>`/`auth.email.notification.<name>` are the same
 * arbitrarily-keyed shape as `auth.external.<name>` above, tracked dynamically
 * in {@link applyRemoteOverride} rather than enumerated here.
 */
const AUTH_EMAIL_TEMPLATE_FIELDS = ["subject", "content_path", "content"] as const;

/** {@link AUTH_EMAIL_TEMPLATE_FIELDS}'s notification-section sibling — same fields, plus `enabled`. */
const AUTH_EMAIL_NOTIFICATION_FIELDS = ["enabled", "subject", "content_path", "content"] as const;

/**
 * Every literal member of {@link ENV_OVERRIDABLE_KEYS}, plus the dotted-key
 * patterns for the dynamically-keyed families {@link applyRemoteOverride}
 * tracks separately. Every `remoteWins(...)` call site is typed against this
 * union, so a typo'd dotted key is a compile error instead of a
 * silently-always-false gate.
 */
export type RemoteOverridableKey =
  | (typeof ENV_OVERRIDABLE_KEYS)[number]
  | `auth.external.${string}.${(typeof AUTH_EXTERNAL_PROVIDER_FIELDS)[number]}`
  | `auth.email.template.${string}.${(typeof AUTH_EMAIL_TEMPLATE_FIELDS)[number]}`
  | `auth.email.notification.${string}.${(typeof AUTH_EMAIL_NOTIFICATION_FIELDS)[number]}`;

/**
 * Hoists the `remoteOverrideKeys.has(key)` closure duplicated across several
 * resolvers into one helper, typed against {@link RemoteOverridableKey} so a
 * typo'd key is a compile error.
 */
export function makeRemoteWins(keys: ReadonlySet<string>): (key: RemoteOverridableKey) => boolean {
  return (key) => keys.has(key);
}

/** Whether `block` provides a value at the dotted `key` path (scalar, array, or sub-table). */
function blockProvidesKey(block: RawDoc, key: string): boolean {
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
): RemoteOverride {
  const remotes = asRecord(doc?.["remotes"]);
  if (doc === undefined || remotes === undefined) return { doc, remoteOverrideKeys: new Set() };
  for (const name of Object.keys(remotes)) {
    const block = asRecord(remotes[name]);
    if (block === undefined) continue;
    // Matches on the raw (env override > unexpanded TOML literal) project_id lookup, so
    // blocks are selected before any `env(...)` literal is expanded.
    if (resolveRemoteProjectId(name, block, lookup) === ref) {
      const merged = deepMergeDoc(doc, block);
      const blockSeed = asRecord(asRecord(block["db"])?.["seed"]);
      // Record every env-overridable key the block supplies, so the resolution below
      // suppresses the matching `SUPABASE_*` override.
      const remoteOverrideKeys = new Set<string>();
      for (const key of ENV_OVERRIDABLE_KEYS) {
        if (blockProvidesKey(block, key)) remoteOverrideKeys.add(key);
      }
      // `auth.external.<name>` is dynamically keyed (see AUTH_EXTERNAL_PROVIDER_FIELDS),
      // so flatten whichever provider names this block actually supplies.
      const externalBlock = asRecord(asRecord(block["auth"])?.["external"]);
      if (externalBlock !== undefined) {
        for (const providerName of Object.keys(externalBlock)) {
          for (const field of AUTH_EXTERNAL_PROVIDER_FIELDS) {
            const key = `auth.external.${providerName}.${field}`;
            if (blockProvidesKey(block, key)) remoteOverrideKeys.add(key);
          }
        }
      }
      // Same dynamically-keyed handling for `auth.email.template.<name>`/`notification.<name>`.
      const emailBlock = asRecord(block["auth"])?.["email"];
      const emailTemplateBlock = asRecord(asRecord(emailBlock)?.["template"]);
      if (emailTemplateBlock !== undefined) {
        for (const templateName of Object.keys(emailTemplateBlock)) {
          for (const field of AUTH_EMAIL_TEMPLATE_FIELDS) {
            const key = `auth.email.template.${templateName}.${field}`;
            if (blockProvidesKey(block, key)) remoteOverrideKeys.add(key);
          }
        }
      }
      const emailNotificationBlock = asRecord(asRecord(emailBlock)?.["notification"]);
      if (emailNotificationBlock !== undefined) {
        for (const notificationName of Object.keys(emailNotificationBlock)) {
          for (const field of AUTH_EMAIL_NOTIFICATION_FIELDS) {
            const key = `auth.email.notification.${notificationName}.${field}`;
            if (blockProvidesKey(block, key)) remoteOverrideKeys.add(key);
          }
        }
      }
      // `db.seed.enabled` is always override-tier: either the block set it, or it's
      // forced false below when omitted — so env never overrides it on a matched-remote run.
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
 * Config load aborts when two `[remotes.*]` blocks declare the same
 * `project_id`. Returns the conflicting pair (current + prior block name) or
 * `undefined`.
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
    // Same raw project_id lookup used for block matching, so dedup uses the same identity.
    const projectId = resolveRemoteProjectId(name, block, lookup);
    if (projectId === undefined) continue;
    const prior = seen.get(projectId);
    if (prior !== undefined) return { name, other: prior };
    seen.set(projectId, name);
  }
  return undefined;
}

/**
 * Rejects any `[remotes.<name>]` whose `project_id` is not a valid project
 * ref, on every config load — so a malformed or missing remote `project_id`
 * fails even local/direct commands before touching the database. Returns the
 * first offending block name (object order) or `undefined`.
 */
function findInvalidRemoteProjectId(
  doc: RawDoc | undefined,
  lookup: EnvLookup,
): string | undefined {
  const remotes = asRecord(doc?.["remotes"]);
  if (remotes === undefined) return undefined;
  for (const name of Object.keys(remotes)) {
    const block = asRecord(remotes[name]);
    // Validates the expanded project_id; an unset `env(...)` stays literal and still
    // fails the ref pattern. (Block matching/dedup above use the raw literal.)
    const projectId = resolveValidatedRemoteProjectId(name, block, lookup);
    if (typeof projectId !== "string" || !PROJECT_REF_PATTERN.test(projectId)) {
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
export function expandEnv(value: string, lookup: (name: string) => string | undefined): string {
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
 * `DbConfigLoadError` rather than silently defaulting and running
 * against the default local database while hiding a broken config.
 */
function resolvePort(value: unknown, fallback: number, lookup: EnvLookup): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= MAX_PORT ? value : undefined;
  }
  if (typeof value === "string") {
    const expanded = expandEnv(value, lookup);
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
    const expanded = expandEnv(value, lookup);
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
    const expanded = expandEnv(value, lookup);
    return expanded.length === 0 ? [] : expanded.split(",");
  }
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    return undefined;
  }
  return value.map((item) => expandEnv(item, lookup));
}

/**
 * Joins `pattern` under `supabase/`, collapsing `.`/`..` segments (e.g.
 * `../seed.sql` → `seed.sql`). The cleaned, forward-slash-only path is the
 * seed-tracking hash key, so an uncollapsed key would miss a previously
 * recorded entry and re-run the seed.
 */
function joinSupabaseSeedPath(pattern: string): string {
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
 * A bare leading separator (`/schemas`) has no Windows volume, so it's
 * relative and joins under `supabase/` — unlike Node's win32 `isAbsolute`,
 * which treats it as rooted at the current drive.
 */
const goIsAbs = (pathSvc: Path.Path, pattern: string): boolean => {
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
export const resolveSeedSqlPath = (pathSvc: Path.Path, pattern: string): string =>
  pattern.length === 0 || goIsAbs(pathSvc, pattern) ? pattern : joinSupabaseSeedPath(pattern);

/** `[db]` ports default through the development env unless `SUPABASE_ENV` overrides. */
const DEFAULT_SUPABASE_ENV = "development";

/**
 * Keys {@link applyProjectEnv} copies from the project `.env` into
 * `process.env`: only values read directly via `process.env` rather than
 * through {@link loadProjectEnv}'s returned map, e.g.
 * `SUPABASE_INTERNAL_IMAGE_REGISTRY` (`getRegistryImageUrl`).
 */
const PROCESS_ENV_APPLY_KEYS = ["SUPABASE_INTERNAL_IMAGE_REGISTRY"] as const;

/**
 * Loads the project's nested `.env` files into a lookup map without mutating
 * `process.env` (first writer wins; the shell environment always wins over any
 * file). Callers needing a key visible to a synchronous `process.env` reader
 * instead opt into {@link applyProjectEnv} around that work.
 */
export const loadProjectEnv = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
) {
  const env = process.env["SUPABASE_ENV"] || DEFAULT_SUPABASE_ENV;
  const filenames = [`.env.${env}.local`];
  if (env !== "test") filenames.push(".env.local");
  filenames.push(`.env.${env}`, ".env");
  // `supabase/` is searched before the repo root; first writer wins.
  const dirs = [path.join(workdir, "supabase"), workdir];
  const loaded: Record<string, string> = {};
  for (const dir of dirs) {
    for (const name of filenames) {
      // A missing file is skipped; any other read error aborts rather than silently
      // running with a broken env file.
      const content = yield* fs.readFileString(path.join(dir, name)).pipe(
        Effect.map(Option.some<string>),
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new DbConfigLoadError({
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
          new DbConfigLoadError({ message: `failed to parse environment file: ${name}` }),
        );
      }
      for (const [key, value] of Object.entries(parsed)) {
        // The shell env and earlier files win; never overrides an already-set key.
        if (process.env[key] === undefined && loaded[key] === undefined) loaded[key] = value;
      }
    }
  }
  return loaded;
});

/**
 * Applies the allowlisted project-`.env` keys (see {@link PROCESS_ENV_APPLY_KEYS})
 * to `process.env` for the duration of the current scope, then reverts —
 * the opt-in counterpart to the pure {@link loadProjectEnv}, kept separate so
 * that loader stays side-effect-free. Never overrides an existing
 * `process.env` value. The `acquireRelease` finalizer deletes only the keys it
 * set, so in-process test workers don't leak env between cases.
 */
export const applyProjectEnv = (
  loaded: Readonly<Record<string, string>>,
  keys: ReadonlyArray<string> = PROCESS_ENV_APPLY_KEYS,
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
 * Resolve a `[section] enabled` style bool: a native TOML bool, or a string
 * (including an `env(VAR)` reference) accepted by {@link parseGoBool}.
 * Returns `"invalid"` for a malformed string; applies `fallback` when the key
 * is absent.
 */
function resolveBool(value: unknown, fallback: boolean, lookup: EnvLookup): boolean | "invalid" {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const parsed = parseGoBool(expandEnv(value, lookup));
    return parsed ?? "invalid";
  }
  // A numeric value decodes as a bool (`value != 0`), so `enabled = 0` is an explicit
  // false, not absent.
  if (typeof value === "number") return value !== 0;
  // A present non-scalar (e.g. `enabled = []`) is a decode error, not absent — it must
  // not fall through to the default and silently pass a config that should have failed.
  if (value === undefined) return fallback;
  return "invalid";
}

/**
 * `resolveBool` that fails the config load on a malformed bool. `envValue` is
 * the `SUPABASE_*` env override, which wins over the TOML value/default when
 * set; an `env(VAR)` indirection in the override is expanded before parsing.
 */
const resolveBoolOrFail = Effect.fnUntraced(function* (
  field: string,
  value: unknown,
  fallback: boolean,
  lookup: EnvLookup,
  envValue?: string,
) {
  if (envValue !== undefined) {
    const parsed = parseGoBool(expandEnv(envValue, lookup));
    if (parsed === undefined) {
      return yield* Effect.fail(
        new DbConfigLoadError({ message: `failed to parse config: invalid ${field}.` }),
      );
    }
    return parsed;
  }
  const resolved = resolveBool(value, fallback, lookup);
  if (resolved === "invalid") {
    return yield* Effect.fail(
      new DbConfigLoadError({ message: `failed to parse config: invalid ${field}.` }),
    );
  }
  return resolved;
});

/**
 * Tri-state sibling of `resolveBoolOrFail` for fields that stay `None` (never
 * `false`) when absent. The `SUPABASE_*` env override wins when present;
 * otherwise a present TOML bool/string is decoded with {@link parseGoBool},
 * and a malformed value aborts the load.
 */
const resolveOptionalBoolOrFail = Effect.fnUntraced(function* (
  field: string,
  envValue: string | undefined,
  value: unknown,
  lookup: EnvLookup,
) {
  if (envValue !== undefined) {
    const parsed = parseGoBool(expandEnv(envValue, lookup));
    if (parsed === undefined) {
      return yield* Effect.fail(
        new DbConfigLoadError({ message: `failed to parse config: invalid ${field}.` }),
      );
    }
    return Option.some(parsed);
  }
  if (typeof value === "boolean") return Option.some(value);
  // A numeric value decodes the same way: `value != 0`.
  if (typeof value === "number") return Option.some(value !== 0);
  if (typeof value === "string") {
    const parsed = parseGoBool(expandEnv(value, lookup));
    if (parsed === undefined) {
      return yield* Effect.fail(
        new DbConfigLoadError({ message: `failed to parse config: invalid ${field}.` }),
      );
    }
    return Option.some(parsed);
  }
  // A present non-scalar value is a decode failure, not absent — reject it here
  // rather than silently treating it as `None`.
  if (value === undefined) return Option.none<boolean>();
  return yield* Effect.fail(
    new DbConfigLoadError({ message: `failed to parse config: invalid ${field}.` }),
  );
});

const VAULT_SECRET_PATH = ["db", "vault", "*"] as const;

/**
 * Dotted paths of every secret-typed config field that must be decryptable —
 * `*` matches any map key (`auth.external.<provider>`, `auth.hook.<name>`,
 * `db.vault.<name>`). `[db.vault]` is included so `config push`'s call to
 * {@link assertDecryptableSecrets} (which has no downstream vault pass of its
 * own) still catches an undecryptable vault secret before it reaches the API.
 * Update alongside any new secret-typed field.
 */
const SECRET_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  ["db", "root_key"],
  VAULT_SECRET_PATH,
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
const collectSecretStrings = (
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
      collectSecretStrings(record[key], segs, index + 1, out);
    }
  } else {
    collectSecretStrings(record[seg], segs, index + 1, out);
  }
};

/** Returns an error message when a single `encrypted:` secret value cannot be decrypted. */
const assertSecretValue = (
  value: string,
  lookup: EnvLookup,
  dotenvPrivateKeys: ReadonlyArray<string>,
): string | undefined => {
  const expanded = expandEnv(value, lookup);
  // An unset `env(...)` or a plain string is returned verbatim (no error).
  if (ENV_PATTERN.test(expanded) || !isEncryptedSecret(expanded)) return undefined;
  const decrypted = decryptSecret(expanded, dotenvPrivateKeys);
  return decrypted.ok ? undefined : `failed to parse config: ${decrypted.error}`;
};

/**
 * Asserts every `encrypted:` value at a {@link SECRET_PATHS} location — in the
 * merged config and each `[remotes.<name>]` block — can be decrypted, failing
 * with `failed to parse config: <error>` if not. Ignores a non-secret string
 * that merely starts with `encrypted:`. Remotes are only checked when `doc`
 * still has its `remotes` key — see `config push`'s SIDE_EFFECTS.md.
 */
export const assertDecryptableSecrets = (
  doc: unknown,
  lookup: EnvLookup,
  dotenvPrivateKeys: ReadonlyArray<string>,
  opts?: { readonly includeVault?: boolean },
): string | undefined => {
  const scan = (node: unknown): string | undefined => {
    for (const segs of SECRET_PATHS) {
      if (opts?.includeVault === false && segs === VAULT_SECRET_PATH) continue;
      const values: Array<string> = [];
      collectSecretStrings(node, segs, 0, values);
      for (const value of values) {
        const error = assertSecretValue(value, lookup, dotenvPrivateKeys);
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

// An absent `auth.site_url` defaults to this value; only an explicit empty string fails.
const DEFAULT_AUTH_SITE_URL = "http://127.0.0.1:3000";

/**
 * Reads `<workdir>/supabase/config.toml` (db subtree + project id) and the linked
 * `<workdir>/supabase/.temp/pooler-url`. `fs`/`path` are passed in so the resolver
 * can capture them once and keep its own `R` at `never`.
 *
 * Fails with `DbConfigLoadError` only when the config file is present but
 * unparseable; an absent file (and an absent/empty pooler-url file) is not an error.
 */
const readDbTomlCore = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  // When set, the `[remotes.<name>]` block whose `project_id` equals `ref` is merged
  // over the base config before fields are read; omitted for `--local`/`--db-url`/declarative.
  ref?: string,
  // Internal: when true, `config.toml` is treated as absent so the body resolves pure
  // defaults (env overrides still apply). Used as the fallback after a config-load
  // failure by the lenient `readDbToml({ validate: false })` wrapper.
  ignoreConfigFile = false,
  // Internal: gates the OrioleDB S3 `assertEnvLoaded` WARN below so it prints at most
  // once per command invocation. Callers that re-read the config internally after an
  // earlier same-invocation read pass `false`.
  warnOnUnresolvedEnv = true,
  resolveVaultSecrets = true,
) {
  const supabaseDir = path.join(workdir, "supabase");
  const configPath = path.join(supabaseDir, "config.toml");

  // A missing file yields defaults; any other read error aborts rather than silently
  // running against the default local database.
  const maybeContent = ignoreConfigFile
    ? Option.none<string>()
    : yield* fs.readFileString(configPath).pipe(
        Effect.map(Option.some<string>),
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new DbConfigLoadError({
                  message: `failed to read file config: ${error.message}`,
                }),
              ),
        ),
      );

  // Built before the remote-config validation/merge below, so remote and top-level
  // `project_id` env() forms are expanded before they are validated or used to derive
  // Docker IDs.
  const projectEnv = yield* loadProjectEnv(fs, path, workdir);
  const lookup: EnvLookup = (name) => process.env[name] ?? projectEnv[name];
  // dotenvx private keys for decrypting `encrypted:` secrets below.
  const dotenvPrivateKeys = collectDotenvPrivateKeys({ ...projectEnv, ...process.env });

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
  // A present `project_id` that env-expands to empty; the `SUPABASE_PROJECT_ID`
  // override below may still rescue it before the check further down fails the load.
  let projectIdExplicitEmpty = false;
  // Keys a matched remote block set at override tier; they must beat matching env
  // overrides below.
  let remoteOverrideKeys: ReadonlySet<string> = new Set();
  // The matched `[remotes.<name>]` block name, echoed as the config-override line.
  let appliedRemote: string | undefined;
  if (Option.isSome(maybeContent)) {
    let doc: RawDoc | undefined;
    try {
      doc = asRecord(SmolToml.parse(maybeContent.value));
    } catch (cause) {
      return yield* Effect.fail(
        new DbConfigLoadError({
          message: `failed to load config: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
      );
    }
    // Config load aborts when two `[remotes.*]` blocks share a `project_id`,
    // regardless of which command runs — check before merging.
    const duplicateRemote = findDuplicateRemoteProjectId(doc, lookup);
    if (duplicateRemote !== undefined) {
      return yield* Effect.fail(
        new DbConfigLoadError({
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
        new DbConfigLoadError({
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
    // Expand `env(VAR)` before deriving the Docker container name from `project_id` —
    // otherwise `project_id = "env(PROJECT_ID)"` would sanitize to the literal string.
    const rawProjectId = effectiveDoc?.["project_id"];
    projectId = nonEmptyString(
      typeof rawProjectId === "string" ? expandEnv(rawProjectId, lookup) : rawProjectId,
    );
    // A present `project_id` string that resolves to empty is a "kept empty override".
    projectIdExplicitEmpty = typeof rawProjectId === "string" && Option.isNone(projectId);

    // Every secret-typed field must be decryptable before validation/connecting. Skips
    // `[db.vault]` when the caller opts out, so the vault loop below only materializes
    // already-proven-decryptable values.
    const secretError = assertDecryptableSecrets(effectiveDoc, lookup, dotenvPrivateKeys, {
      includeVault: resolveVaultSecrets,
    });
    if (secretError !== undefined) {
      return yield* Effect.fail(new DbConfigLoadError({ message: secretError }));
    }
  }
  // `remoteOverrideKeys` has its final value from here on — see `makeRemoteWins`'s own doc
  // comment for why this is typed narrower than the `ReadonlySet<string>` it wraps.
  const remoteWins = makeRemoteWins(remoteOverrideKeys);

  // Read the linked pooler URL from `.temp/pooler-url` and treat it as configured only
  // when the file exists and is non-empty.
  const poolerUrlPath = path.join(supabaseDir, ".temp", "pooler-url");
  const poolerConnectionString = yield* fs
    .readFileString(poolerUrlPath)
    .pipe(Effect.map(nonEmptyString), Effect.orElseSucceed(Option.none<string>));

  // `SUPABASE_DB_*` env vars override the matching `[db]` field before the TOML
  // value/default. An empty env value is ignored, and the project `.env` files are
  // loaded into the environment first, so consult both.
  const envOverride = (name: string): string | undefined => {
    const fromShell = process.env[name];
    if (fromShell !== undefined && fromShell.length > 0) return fromShell;
    const fromFile = projectEnv[name];
    return fromFile !== undefined && fromFile.length > 0 ? fromFile : undefined;
  };

  // `SUPABASE_PROJECT_ID` overrides the top-level `project_id` used to name the local
  // stack's Docker resources, unless a matched `[remotes.<ref>]` block already set
  // `project_id` at override tier — that value must win over a stale/differently-scoped
  // env var.
  const projectIdEnv = remoteWins("project_id") ? undefined : envOverride("SUPABASE_PROJECT_ID");
  if (projectIdEnv !== undefined) {
    projectId = nonEmptyString(expandEnv(projectIdEnv, lookup));
  }

  // An absent `project_id` is tolerated here (deferred); a present `project_id = ""`
  // that the env override didn't rescue fails the load, so a destructive command (e.g.
  // remote `db reset`) fails fast instead of running against a config that should have
  // already failed validation.
  if (projectIdExplicitEmpty && Option.isNone(projectId)) {
    return yield* Effect.fail(
      new DbConfigLoadError({ message: "Missing required field in config: project_id" }),
    );
  }

  // A present-but-unmarshalable port aborts rather than defaulting, so a broken `[db]`
  // config never silently targets the default local database.
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
      new DbConfigLoadError({
        message: `failed to load config: invalid ${port === undefined ? "db.port" : "db.shadow_port"} value`,
      }),
    );
  }
  // An explicit `db.port = 0` is a load error (an absent port is defaulted first);
  // `resolvePort` accepts 0 as a valid uint16, so the zero check lives here. No
  // equivalent check for `shadow_port`.
  if (port === 0) {
    return yield* Effect.fail(
      new DbConfigLoadError({ message: "Missing required field in config: db.port" }),
    );
  }

  // `db.password` isn't part of the config schema — it's a TS-only extension for
  // `--local` connections. Must not read `DB_PASSWORD` (linked-only), or `db query
  // --local` etc. would authenticate with a remote secret.
  const passwordRaw = typeof db?.["password"] === "string" ? db["password"] : undefined;

  // `env(VAR)` is expanded, then the result must decode as a whole integer (`17foo` is
  // not truncated to 17); `SUPABASE_DB_MAJOR_VERSION` overrides the TOML value.
  const majorVersionRaw =
    (remoteWins("db.major_version") ? undefined : envOverride("SUPABASE_DB_MAJOR_VERSION")) ??
    db?.["major_version"];
  const majorVersionResolved = resolveConfigInt(majorVersionRaw, lookup);
  if (majorVersionResolved === "invalid") {
    // Present but not a whole integer (`17foo`, or an `env(VAR)` that does not
    // resolve to digits): fail the config parse rather than defaulting.
    const shown =
      typeof majorVersionRaw === "string"
        ? expandEnv(majorVersionRaw, lookup)
        : String(majorVersionRaw);
    return yield* Effect.fail(
      new DbConfigLoadError({
        message: `Failed reading config: Invalid db.major_version: ${shown}.`,
      }),
    );
  }
  // An unsupported major version is rejected by the single `validateResolvedConfig`
  // call below; an absent value defaults first, a present one (including 0) flows through.
  const majorVersion =
    typeof majorVersionResolved === "number" ? majorVersionResolved : DEFAULT_MAJOR_VERSION;

  // On a 15/17 project, validation rewrites the Postgres image to the OrioleDB tag and
  // checks the four S3 fields below; the image rewrite itself happens in `resolveDbImage`.
  const expandString = (value: unknown): Option.Option<string> =>
    typeof value === "string" ? nonEmptyString(expandEnv(value, lookup)) : Option.none();
  const orioledbVersion = expandString(experimentalRaw?.["orioledb_version"]);
  if (Option.isSome(orioledbVersion) && (majorVersion === 15 || majorVersion === 17)) {
    // Warns (does not fail) when an S3 field still holds an unexpanded `env(VAR)`;
    // matches the established stderr line, with the env var name from the capture.
    const s3Fields = ["s3_host", "s3_region", "s3_access_key", "s3_secret_key"] as const;
    for (const field of s3Fields) {
      const raw = experimentalRaw?.[field];
      if (typeof raw !== "string") continue;
      const expanded = expandEnv(raw, lookup);
      const unset = ENV_PATTERN.exec(expanded);
      if (unset !== null && warnOnUnresolvedEnv) {
        process.stderr.write(`WARN: environment variable is unset: ${unset[1] ?? ""}\n`);
      }
    }
  }

  // Selects the edge-runtime image tag (`deno1` when 1, otherwise the default); pg-delta
  // needs it to pick the matching image. `SUPABASE_EDGE_RUNTIME_DENO_VERSION` overrides
  // the TOML value before validation.
  const denoVersionRaw =
    (remoteWins("edge_runtime.deno_version")
      ? undefined
      : envOverride("SUPABASE_EDGE_RUNTIME_DENO_VERSION")) ?? edgeRuntimeRaw?.["deno_version"];
  // A present non-integer string or unresolved `env(MISSING)` aborts the load rather
  // than falling through to the default Deno 2 image.
  const denoVersionResolved = resolveConfigInt(denoVersionRaw, lookup);
  if (denoVersionResolved === "invalid") {
    const shown =
      typeof denoVersionRaw === "string"
        ? expandEnv(denoVersionRaw, lookup)
        : String(denoVersionRaw);
    return yield* Effect.fail(
      new DbConfigLoadError({
        message: `Failed reading config: Invalid edge_runtime.deno_version: ${shown}.`,
      }),
    );
  }
  // An invalid deno_version is rejected by the single `validateResolvedConfig` call
  // below; an absent key falls through to the default (2).
  const denoVersion =
    typeof denoVersionResolved === "number" ? denoVersionResolved : DEFAULT_DENO_VERSION;

  // `[experimental.webhooks]` only exists to be turned ON: any present section whose
  // `enabled` isn't explicitly `true` is rejected. Unlike `pgdelta.enabled` below,
  // `SUPABASE_EXPERIMENTAL_WEBHOOKS_ENABLED` only applies when the section itself is
  // declared — gate the env read on `webhooksPresent`, not just later validation.
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
    const expandedWebhooksEnabledEnv = expandEnv(webhooksEnabledEnv, lookup);
    const parsed = parseGoBool(expandedWebhooksEnabledEnv);
    if (parsed === undefined) {
      return yield* Effect.fail(
        new DbConfigLoadError({
          message: `failed to parse config: invalid experimental.webhooks.enabled: ${expandedWebhooksEnabledEnv}.`,
        }),
      );
    }
    webhooksEnabled = parsed;
  } else if (typeof webhooksEnabledRaw === "boolean") {
    webhooksEnabled = webhooksEnabledRaw;
  } else if (typeof webhooksEnabledRaw === "number") {
    // A numeric `enabled = 1` is true (`value != 0`), same as `experimental.pgdelta.enabled` below.
    webhooksEnabled = webhooksEnabledRaw !== 0;
  } else if (typeof webhooksEnabledRaw === "string") {
    const parsed = parseGoBool(expandEnv(webhooksEnabledRaw, lookup));
    if (parsed === undefined) {
      return yield* Effect.fail(
        new DbConfigLoadError({
          message: `failed to parse config: invalid experimental.webhooks.enabled: ${expandEnv(webhooksEnabledRaw, lookup)}.`,
        }),
      );
    }
    webhooksEnabled = parsed;
  } else {
    webhooksEnabled = false;
  }

  // `[experimental.pgdelta]`. `enabled` accepts a TOML bool or a string (including
  // `env(VAR)`); `declarative_schema_path` is resolved to a `supabase/`-prefixed path
  // when relative. `SUPABASE_EXPERIMENTAL_PGDELTA_*` overrides the TOML before
  // validation.
  const enabledRaw = pgDeltaRaw?.["enabled"];
  const enabledEnv = remoteWins("experimental.pgdelta.enabled")
    ? undefined
    : envOverride("SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED");
  // `"1"` counts as true and a malformed value aborts the load. The env override wins,
  // then the TOML bool, then an `env(VAR)` string, defaulting to false when absent.
  let enabled: boolean;
  if (enabledEnv !== undefined) {
    // An `env(VAR)` indirection in the override is expanded before the bool parse.
    const expandedEnabledEnv = expandEnv(enabledEnv, lookup);
    const parsed = parseGoBool(expandedEnabledEnv);
    if (parsed === undefined) {
      return yield* Effect.fail(
        new DbConfigLoadError({
          message: `failed to parse config: invalid experimental.pgdelta.enabled: ${expandedEnabledEnv}.`,
        }),
      );
    }
    enabled = parsed;
  } else if (typeof enabledRaw === "boolean") {
    enabled = enabledRaw;
  } else if (typeof enabledRaw === "number") {
    // A numeric `enabled = 1` is true (`value != 0`), same rule as the generic `resolveBool`.
    enabled = enabledRaw !== 0;
  } else if (typeof enabledRaw === "string") {
    const parsed = parseGoBool(expandEnv(enabledRaw, lookup));
    if (parsed === undefined) {
      return yield* Effect.fail(
        new DbConfigLoadError({
          message: `failed to parse config: invalid experimental.pgdelta.enabled: ${expandEnv(enabledRaw, lookup)}.`,
        }),
      );
    }
    enabled = parsed;
  } else {
    enabled = false;
  }

  const declarativeSchemaPathRaw = pgDeltaRaw?.["declarative_schema_path"];
  // Expand `env(VAR)` in whichever source wins (override or TOML literal) before the
  // path is used (`expandEnv` is a no-op on a non-`env()` string).
  const declarativeSchemaPathValue = expandEnv(
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
  // Expand the resolved value (env override or TOML literal) before the JSON validation
  // below runs.
  const formatOptionsExpanded = expandEnv(
    (remoteWins("experimental.pgdelta.format_options")
      ? undefined
      : envOverride("SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS")) ??
      (typeof formatOptionsRaw === "string" ? formatOptionsRaw : ""),
    lookup,
  );
  // A non-empty, non-JSON `format_options` is rejected by the single
  // `validateResolvedConfig` call below.
  const formatOptions = nonEmptyString(formatOptionsExpanded);

  // Bucket-name/function-slug validation lives in `validateResolvedConfig` (called
  // once, below); only the pure extraction stays here.
  const bucketsRaw = asRecord(storageRaw?.["buckets"]);
  // Validates each bucket's own `file_size_limit` eagerly, so a malformed value is
  // caught even on a restart that never reaches Storage bring-up. Validate-only —
  // `seedBucketsRun` re-parses the real value when it actually seeds.
  if (bucketsRaw !== undefined) {
    for (const [bucketName, bucketRaw] of Object.entries(bucketsRaw)) {
      const rawLimit = asRecord(bucketRaw)?.["file_size_limit"];
      if (typeof rawLimit !== "string" && typeof rawLimit !== "number") continue;
      const limitString =
        typeof rawLimit === "number" ? String(rawLimit) : expandEnv(rawLimit, lookup);
      try {
        ramInBytes(limitString);
      } catch {
        return yield* Effect.fail(
          new DbConfigLoadError({
            message: `failed to parse config: invalid storage.buckets.${bucketName}.file_size_limit.`,
          }),
        );
      }
    }
  }

  // Gated on `auth.enabled` (default true); `SUPABASE_AUTH_ENABLED` decides whether the
  // auth block is validated, unless a matched remote block set `auth.enabled` itself.
  const authEnabled = yield* resolveBoolOrFail(
    "auth.enabled",
    authRaw?.["enabled"],
    true,
    lookup,
    remoteWins("auth.enabled") ? undefined : envOverride("SUPABASE_AUTH_ENABLED"),
  );

  // `str`/`gate`/`fail` build `AuthInput` for the shared validator call below, and back
  // the sms/external checks further down that only this reader performs.
  const fail = (message: string) => Effect.fail(new DbConfigLoadError({ message }));
  // Env-expanded string of `rec[key]` ("" when absent/non-string). An unresolved
  // `env(VAR)` stays literal (non-empty).
  const str = (rec: RawDoc | undefined, key: string): string => {
    const value = rec?.[key];
    return typeof value === "string" ? expandEnv(value, lookup) : "";
  };
  // Accepts a boolean, nonzero number, or parseable string; a malformed string aborts
  // the load rather than coercing to false. Absent/non-string → false.
  const gate = (rec: RawDoc | undefined, key: string, field: string) =>
    Effect.gen(function* () {
      const value = rec?.[key];
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      if (typeof value !== "string") return false;
      const parsed = parseGoBool(expandEnv(value, lookup));
      if (parsed === undefined) return yield* fail(`failed to parse config: invalid ${field}.`);
      return parsed;
    });

  const authRawResolved = authRaw ?? {};
  let authInput: AuthInput | undefined;
  if (authEnabled) {
    // A1: site_url required.
    const siteUrl =
      authRawResolved["site_url"] === undefined
        ? DEFAULT_AUTH_SITE_URL
        : str(authRawResolved, "site_url");

    // A4: [auth.captcha]. The provider enum check and the `enabled`-gated
    // required-field checks both live in `validateResolvedConfig`.
    const captchaRaw = asRecord(authRawResolved["captcha"]);
    let captchaInput: CaptchaInput | undefined;
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

    // A5: signing keys file load (I/O). A relative path resolves under the supabase
    // dir; absolute is verbatim.
    const signingKeysPath = str(authRawResolved, "signing_keys_path");
    if (signingKeysPath.length > 0) {
      const keysJson = yield* fs
        .readFileString(resolveSigningKeysPath(workdir, signingKeysPath))
        .pipe(
          Effect.mapError(
            (cause) => new DbConfigLoadError({ message: signingKeysReadErrorMessage(cause) }),
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
        catch: (cause) => new DbConfigLoadError({ message: signingKeysDecodeErrorMessage(cause) }),
      });
    }

    // A6: passkey/webauthn when passkey enabled.
    const passkeyRaw = asRecord(authRawResolved["passkey"]);
    let passkeyInput: PasskeyInput | undefined;
    if (passkeyRaw !== undefined && (yield* gate(passkeyRaw, "enabled", "auth.passkey.enabled"))) {
      const webauthnRaw = asRecord(authRawResolved["webauthn"]);
      const rpOriginsRaw = webauthnRaw?.["rp_origins"];
      // `rp_origins` may be a comma-separated string (raw or `env(...)`-resolved) rather
      // than a literal TOML array; split it, matching `local-config-values.ts`'s
      // handling of this same field.
      const rpOrigins = Array.isArray(rpOriginsRaw)
        ? rpOriginsRaw
        : strToArr(str(webauthnRaw, "rp_origins"));
      passkeyInput = {
        webauthnPresent: webauthnRaw !== undefined,
        rpId: str(webauthnRaw, "rp_id"),
        rpOrigins: rpOrigins.length > 0 ? rpOrigins : undefined,
      };
    }

    // B1: hooks — each enabled hook, checked in this fixed order.
    const hookRaw = asRecord(authRawResolved["hook"]);
    const hookTypes = [
      "mfa_verification_attempt",
      "password_verification_attempt",
      "custom_access_token",
      "send_sms",
      "send_email",
      "before_user_created",
    ] as const;
    const hooks: Array<HookInput> = [];
    for (const hookType of hookTypes) {
      const h = asRecord(hookRaw?.[hookType]);
      if (h !== undefined && (yield* gate(h, "enabled", `auth.hook.${hookType}.enabled`))) {
        hooks.push({ type: hookType, uri: str(h, "uri"), secrets: str(h, "secrets") });
      }
    }

    // B2: mfa — enroll requires verify, fixed totp/phone/web_authn order.
    const mfaRaw = asRecord(authRawResolved["mfa"]);
    const mfa: Array<MfaFactorInput> = [];
    for (const label of ["totp", "phone", "web_authn"] as const) {
      const factor = asRecord(mfaRaw?.[label]);
      mfa.push({
        label,
        enrollEnabled: yield* gate(factor, "enroll_enabled", `auth.mfa.${label}.enroll_enabled`),
        verifyEnabled: yield* gate(factor, "verify_enabled", `auth.mfa.${label}.verify_enabled`),
      });
    }

    // B3: email — template/notification content is I/O. Config loading resolves every
    // relative `content_path` from the project root; absolute paths remain unchanged.
    const emailRaw = asRecord(authRawResolved["email"]);
    const templatesRaw = asRecord(emailRaw?.["template"]);
    if (templatesRaw !== undefined) {
      for (const name of Object.keys(templatesRaw)) {
        const tmpl = asRecord(templatesRaw[name]);
        if (tmpl === undefined) continue;
        const contentPath = yield* Effect.try({
          try: () =>
            resolveEmailTemplateContentPath({
              section: "template",
              name,
              contentPath: str(tmpl, "content_path"),
              contentPresent: tmpl["content"] !== undefined,
              base: workdir,
            }),
          catch: (cause) =>
            new DbConfigLoadError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        if (contentPath === undefined) continue;
        yield* fs.readFileString(contentPath).pipe(
          Effect.mapError(
            (cause) =>
              new DbConfigLoadError({
                message: emailContentPathReadErrorMessage("template", name, cause),
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
            resolveEmailTemplateContentPath({
              section: "notification",
              name,
              contentPath: str(tmpl, "content_path"),
              contentPresent: tmpl["content"] !== undefined,
              base: workdir,
            }),
          catch: (cause) =>
            new DbConfigLoadError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
        if (contentPath === undefined) continue;
        yield* fs.readFileString(contentPath).pipe(
          Effect.mapError(
            (cause) =>
              new DbConfigLoadError({
                message: emailContentPathReadErrorMessage("notification", name, cause),
              }),
          ),
        );
      }
    }
    // A present `[auth.email.smtp]` table defaults `enabled` to true unless explicitly
    // disabled.
    const smtpRaw = asRecord(emailRaw?.["smtp"]);
    let smtpInput: SmtpInput | undefined;
    if (smtpRaw !== undefined) {
      const smtpPortRaw = smtpRaw["port"];
      // The shared validator's required-field check is `port === 0`. A non-numeric `port`
      // (or unresolved `env(VAR)`) parses to `NaN` here — normalize that to `0` so it
      // still trips the check instead of silently passing.
      const smtpPortNumeric =
        typeof smtpPortRaw === "number"
          ? smtpPortRaw
          : typeof smtpPortRaw === "string"
            ? Number(expandEnv(smtpPortRaw, lookup))
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

    // B6: third_party — each enabled provider, checked in this fixed order.
    // `aws_cognito`'s error messages say "cognito", not "aws_cognito".
    const thirdPartyRaw = asRecord(authRawResolved["third_party"]);
    const thirdParty: Array<ThirdPartyInput> = [];
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

  // Computed after the auth block, before the shared validator call: `analyticsEnabled`
  // can itself fail on a malformed bool, and that failure must report after an
  // auth-block error for a config broken in both places. An absent `[analytics]`
  // section defaults to enabled+postgres.
  const analyticsString = (
    key: "backend" | "gcp_project_id" | "gcp_project_number" | "gcp_jwt_path",
    envName: string,
  ): string => {
    const fromEnv = remoteWins(`analytics.${key}`) ? undefined : envOverride(envName);
    const raw = fromEnv ?? analyticsRaw?.[key];
    return typeof raw === "string" ? expandEnv(raw, lookup) : "";
  };
  const analyticsBackend = analyticsString("backend", "SUPABASE_ANALYTICS_BACKEND");
  const analyticsEnabled = yield* resolveBoolOrFail(
    "analytics.enabled",
    analyticsRaw?.["enabled"],
    true,
    lookup,
    remoteWins("analytics.enabled") ? undefined : envOverride("SUPABASE_ANALYTICS_ENABLED"),
  );
  // Each GCP value is env-expanded, so an unresolved `env(VAR)` stays non-empty and
  // passes the shared validator's `length === 0` check.
  const gcpProjectId = analyticsString("gcp_project_id", "SUPABASE_ANALYTICS_GCP_PROJECT_ID");
  const gcpProjectNumber = analyticsString(
    "gcp_project_number",
    "SUPABASE_ANALYTICS_GCP_PROJECT_NUMBER",
  );
  const gcpJwtPath = analyticsString("gcp_jwt_path", "SUPABASE_ANALYTICS_GCP_JWT_PATH");

  // Every check `validateResolvedConfig` owns runs through this single call (except
  // `db.port`, checked earlier above). The sms/external checks below, which only this
  // reader performs, run after this call succeeds, still gated on `authEnabled`.
  const dbInput: DbInput = { port, majorVersion };
  const analyticsInput: AnalyticsInput = {
    enabled: analyticsEnabled,
    backend: analyticsBackend.length > 0 ? analyticsBackend : undefined,
    gcpProjectId,
    gcpProjectNumber,
    gcpJwtPath,
  };
  const experimentalInput: ExperimentalInput = {
    webhooksPresent,
    webhooksEnabled,
    pgdeltaFormatOptions: formatOptionsExpanded,
  };
  const validationInput: ConfigValidationInput = {
    db: dbInput,
    storageBucketNames: bucketsRaw !== undefined ? Object.keys(bucketsRaw) : [],
    functionSlugs: functionsRaw !== undefined ? Object.keys(functionsRaw) : [],
    auth: authInput,
    edgeRuntimeDenoVersion: denoVersion,
    analytics: analyticsInput,
    experimental: experimentalInput,
  };
  yield* Effect.try({
    try: () => validateResolvedConfig(validationInput),
    catch: (cause) =>
      new DbConfigLoadError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

  if (authEnabled) {
    // B4: sms — only this reader validates it; only the first enabled provider is checked.
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

    // B5: external providers — only this reader validates it. linkedin/slack are
    // deprecated and skipped.
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

  // `[db.migrations] enabled` — default true, overridable by
  // `SUPABASE_DB_MIGRATIONS_ENABLED` unless the matched remote block explicitly set it.
  const migrationsRaw = asRecord(db?.["migrations"]);
  const migrationsEnabled = yield* resolveBoolOrFail(
    "db.migrations.enabled",
    migrationsRaw?.["enabled"],
    true,
    lookup,
    remoteWins("db.migrations.enabled") ? undefined : envOverride("SUPABASE_DB_MIGRATIONS_ENABLED"),
  );
  // `[db.seed]` — default enabled true, sql_paths `["seed.sql"]`; relative patterns are
  // supabase-prefixed. Overridable by `SUPABASE_DB_SEED_ENABLED` unless a matched remote
  // block supplied it at the override tier (set or forced false).
  const seedRaw = asRecord(db?.["seed"]);
  const seedEnabled = yield* resolveBoolOrFail(
    "db.seed.enabled",
    seedRaw?.["enabled"],
    true,
    lookup,
    remoteWins("db.seed.enabled") ? undefined : envOverride("SUPABASE_DB_SEED_ENABLED"),
  );
  // A string value (env override or TOML string) is env-expanded, then comma-split (no
  // trimming; empty → `[]`). An array is decoded element-by-element: each element is
  // expanded but not re-split, so `["env(SEEDS)"]` stays one pattern. The env override
  // wins over the TOML value; absent/invalid falls back to the caller's default.
  const splitGoSeedPaths = (value: string): ReadonlyArray<string> => {
    const expanded = expandEnv(value, lookup);
    return expanded.length === 0 ? [] : expanded.split(",");
  };
  /**
   * Formats a float the way a weakly-decoded TOML `Glob` array element renders as a
   * string: always fixed notation (never scientific), `+Inf`/`-Inf`/`NaN` spelled that
   * way, and a negative zero keeps its sign — so the resolved pattern's hash key matches
   * an existing recorded entry.
   */
  const formatGoWeakFloat = (value: number): string => {
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
  // A non-string array element isn't dropped: a bool coerces to `"1"`/`"0"` and a
  // number to its decimal string, then flows through the same env-expand/resolve
  // pipeline as a real string entry.
  const weakCoerceGlobEntry = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (typeof value === "boolean") return value ? "1" : "0";
    if (typeof value === "number") return formatGoWeakFloat(value);
    return undefined;
  };
  // A non-scalar glob element (nested array/table, or a bare TOML datetime) fails with
  // an "unconvertible type" error instead of being silently dropped; each datetime
  // variant reports its own type name for the message. `smol-toml` parses every TOML
  // datetime to a `TomlDate` (a `Date` subclass), exposing the `isDate`/`isTime`/
  // `isLocal` discriminators needed to pick the right variant name.
  const goTomlDateType = (value: SmolToml.TomlDate): string => {
    if (value.isDate()) return "toml.LocalDate";
    if (value.isTime()) return "toml.LocalTime";
    return value.isLocal() ? "toml.LocalDateTime" : "time.Time";
  };
  const goUnconvertibleType = (value: unknown): string | undefined =>
    value instanceof SmolToml.TomlDate
      ? goTomlDateType(value)
      : Array.isArray(value)
        ? "[]interface {}"
        : typeof value === "object" && value !== null
          ? "map[string]interface {}"
          : undefined;
  // Returns the "unconvertible type" issue for each bad array element, without
  // failing — both `Glob` fields' issues are combined into one error afterward (see
  // `failOnGlobIssues`), with `db.migrations.schema_paths` ordered before `db.seed.sql_paths`.
  const globArrayIssues = (
    keyPath: string,
    values: ReadonlyArray<unknown>,
  ): ReadonlyArray<string> =>
    values.flatMap((value, index) => {
      const goType = goUnconvertibleType(value);
      return goType === undefined
        ? []
        : [`'${keyPath}[${index}]' expected type 'string', got unconvertible type '${goType}'`];
    });
  // Fails once with every issue collected across both `Glob` fields, instead of
  // failing on the first field checked.
  const failOnGlobIssues = (
    issues: ReadonlyArray<string>,
  ): Effect.Effect<void, DbConfigLoadError> =>
    issues.length === 0
      ? Effect.void
      : fail(
          `failed to parse config: decoding failed due to the following error(s):\n\n${issues.join("\n")}`,
        );
  // A scalar top-level value (e.g. `schema_paths = 42`) is treated like a
  // single-element array: a zero-length map decodes to `[]`, anything else weakly
  // coerces or reports an unconvertible-type issue. A `TomlDate` must not match the
  // zero-length-map case — its value is stored internally, so `Object.keys` is empty
  // too, but it should still be treated as unconvertible.
  const resolveScalarGlobFallback = (
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
    const coerced = weakCoerceGlobEntry(value);
    if (coerced !== undefined) {
      return { resolved: [coerced], issues: [] };
    }
    return { resolved: [], issues: globArrayIssues(keyPath, [value]) };
  };
  /**
   * Resolves one `Glob`-typed field into its pre-supabase-join patterns: env override,
   * real array, bare string, absent key (caller's default), or the scalar fallback
   * above. Returns issues instead of failing — see {@link failOnGlobIssues}.
   */
  const resolveGlobField = (
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
          .map((pattern) => weakCoerceGlobEntry(pattern))
          .filter((pattern): pattern is string => pattern !== undefined)
          .map((pattern) => expandEnv(pattern, lookup)),
        issues: globArrayIssues(keyPath, raw),
      };
    }
    if (typeof raw === "string") {
      return { patterns: splitGoSeedPaths(raw), issues: [] };
    }
    if (raw === undefined) {
      return { patterns: absentDefault, issues: [] };
    }
    const fallback = resolveScalarGlobFallback(keyPath, raw);
    return {
      patterns: fallback.resolved.map((pattern) => expandEnv(pattern, lookup)),
      issues: fallback.issues,
    };
  };
  const rawSqlPaths = seedRaw?.["sql_paths"];
  const sqlPathsOverride = remoteWins("db.seed.sql_paths")
    ? undefined
    : envOverride("SUPABASE_DB_SEED_SQL_PATHS");
  const sqlPathsResolved = resolveGlobField("db.seed.sql_paths", rawSqlPaths, sqlPathsOverride, [
    "seed.sql",
  ]);
  // Patterns are already env-expanded above (expansion runs before the split); resolve
  // each to its config-load form (absolute verbatim, relative supabase-joined).
  const seedSqlPaths = sqlPathsResolved.patterns.map((pattern) =>
    resolveSeedSqlPath(path, pattern),
  );

  // `[db.migrations] schema_paths` — default `[]`, resolved the same way as
  // `[db.seed].sql_paths` above, but unconditionally (not gated on `db.migrations.enabled`).
  const rawSchemaPaths = migrationsRaw?.["schema_paths"];
  const schemaPathsOverride = remoteOverrideKeys.has("db.migrations.schema_paths")
    ? undefined
    : envOverride("SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS");
  const schemaPathsResolved = resolveGlobField(
    "db.migrations.schema_paths",
    rawSchemaPaths,
    schemaPathsOverride,
    [],
  );

  // Combines both `Glob` fields' issues before failing once, so a config invalid in
  // both surfaces both instead of only the first field checked.
  yield* failOnGlobIssues([...schemaPathsResolved.issues, ...sqlPathsResolved.issues]);

  const schemaPaths = schemaPathsResolved.patterns.map((pattern) =>
    resolveSeedSqlPath(path, pattern),
  );

  // `[db.vault]` secrets: env-expand each value, then decrypt dotenvx `encrypted:`
  // ciphertext. `resolved` is true only after a successful decrypt-or-passthrough. An
  // `encrypted:` value that cannot be decrypted aborts the command, never silently skipped.
  const vault: Array<DbVaultSecretToml> = [];
  if (resolveVaultSecrets && vaultRaw !== undefined) {
    for (const name of Object.keys(vaultRaw).sort()) {
      const raw = vaultRaw[name];
      const value = typeof raw === "string" ? expandEnv(raw, lookup) : "";
      // Empty or an unexpanded `env(...)` reference is left unresolved rather than hashed.
      if (value.length === 0 || ENV_PATTERN.test(value)) {
        vault.push({ name, value, resolved: false });
        continue;
      }
      if (isEncryptedSecret(value)) {
        const decrypted = decryptSecret(value, dotenvPrivateKeys);
        if (!decrypted.ok) {
          return yield* Effect.fail(
            new DbConfigLoadError({ message: `failed to parse config: ${decrypted.error}` }),
          );
        }
        vault.push({ name, value: decrypted.value, resolved: true });
        continue;
      }
      vault.push({ name, value, resolved: true });
    }
  }

  // `[api] auto_expose_new_tables` is tri-state: present → `Some(bool)`, absent →
  // `None` (never false). A malformed override/value aborts the load rather than
  // silently coercing to false.
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
      new DbConfigLoadError({ message: "failed to parse config: invalid api.schemas." }),
    );
  }

  const values: DbTomlValues = {
    projectEnv,
    envLookup: envOverride,
    apiSchemas,
    port,
    shadowPort,
    password: passwordRaw !== undefined ? expandEnv(passwordRaw, lookup) : DEFAULT_PASSWORD,
    poolerConnectionString,
    projectId,
    majorVersion,
    orioledbVersion,
    denoVersion,
    pgDelta: {
      enabled,
      declarativeSchemaPath,
      formatOptions,
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
 * Reads and validates `config.toml`: an absent file yields defaults, but a present
 * config that is unreadable, malformed, references an undecryptable secret, or fails
 * validation aborts with a matching error. Call this before asserting the stack is
 * running, prompting, or any destructive work.
 */
export const checkDbToml = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  ref?: string,
  // See `readDbTomlCore`'s doc comment. Pass `false` only when an earlier,
  // same-invocation call already printed the OrioleDB S3 WARN once.
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
 * Reads `config.toml`. Defaults to the same validating behavior as
 * {@link checkDbToml}; pass `{ validate: false }` for a best-effort read that never
 * throws — a config-load failure falls back to pure defaults (env overrides still
 * applied), for callers that only need `projectId` and don't require a fully
 * validated config.
 */
export const readDbToml = (
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
        Effect.catchTag("DbConfigLoadError", () =>
          readDbTomlCore(fs, path, workdir, ref, true, warnOnUnresolvedEnv, resolveVaultSecrets),
        ),
      )
    : readDbTomlCore(fs, path, workdir, ref, false, warnOnUnresolvedEnv, resolveVaultSecrets);
};

/**
 * The effective declarative schema directory: the configured
 * `declarative_schema_path` (already `supabase/`-prefixed when relative) or the
 * default `supabase/schemas`. `path` joins the segments so the separator matches the
 * host platform.
 */
export function resolveDeclarativeDir(path: Path.Path, pgDelta: PgDeltaTomlConfig): string {
  return Option.getOrElse(pgDelta.declarativeSchemaPath, () =>
    path.join(...DEFAULT_DECLARATIVE_DIR_SEGMENTS),
  );
}
