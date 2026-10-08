import {
  DEFAULT_LOCAL_DATABASE_PASSWORD,
  DEFAULT_POSTGRES_ROOT_KEY,
} from "@supabase/stack/defaults";

import { sanitizeProjectId } from "../command-internal/docker-ids.ts";
import { resolveSeedSqlPath } from "../command-internal/seed-path.ts";
import type { CliConfigFlagDeclaration } from "./cli-config-flags.ts";
import {
  binaryCodec,
  commaListCodec,
  goBoolCodec,
  literalCodec,
  stringCodec,
  type CliConfigCodec,
  type CliConfigKeyContext,
} from "./cli-config-key.ts";

/** A hand-written registry entry for a key the schema walk cannot produce. */
export interface CliConfigKeyDef {
  readonly path: string;
  readonly codec: CliConfigCodec<unknown>;
  /** Consumers read `Option<X>`; absent keys default to `None`. */
  readonly optional?: true;
  readonly default?: unknown;
  readonly defaultFrom?: (ctx: CliConfigKeyContext) => unknown;
  /** `[0]` canonical; omitted derives `SUPABASE_` + UPPER_SNAKE(path). */
  readonly env?: ReadonlyArray<string>;
  /** Never overridable from the environment. */
  readonly noEnv?: true;
  readonly secret?: true;
  /** Not a config document path: the document is never consulted. */
  readonly document?: false;
  readonly envScope?: "linkedTarget";
  /** `materialize` writes the default into the decoded config when no tier supplies a value. */
  readonly materializeDefault?: true;
}

/** Deprecated env names that still resolve to the key at the given path. */
export const CLI_CONFIG_ENV_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "experimental.pgdelta.enabled": ["SUPABASE_EXPERIMENTAL_PG_DELTA"],
};

/** Schema leaves whose env decoding differs from the schema-derived codec. */
export const CLI_CONFIG_CODEC_OVERRIDES: Readonly<Record<string, CliConfigCodec<unknown>>> = {
  "experimental.stack": binaryCodec,
  "experimental.compute": binaryCodec,
  "edge_runtime.policy": literalCodec(["per_worker", "oneshot"]),
  "auth.password_requirements": {
    ...literalCodec([
      "",
      "letters_digits",
      "lower_upper_letters_digits",
      "lower_upper_letters_digits_symbols",
    ]),
    describe: (path, raw) => `Failed reading config: Invalid ${path}: ${raw}.`,
  },
};

/**
 * Schema leaves the registry cannot encode as a key, with the reason. Registry construction throws
 * for any other leaf without a codec.
 */
export const CLI_CONFIG_SCHEMA_EXCLUDED: Readonly<Record<string, string>> = {
  "experimental.inspect.rules": "a list of tables, not strings; read from the document",
};

/** Schema leaves that are not env-overridable, with the reason. */
export const CLI_CONFIG_ENV_EXCLUDED: Readonly<Record<string, string>> = {
  "experimental.orioledb_version": "deprecated; promoted to db.orioledb_version before resolution",
};

/** Optional schema leaves that consumers read as a plain value with a context default. */
export const CLI_CONFIG_CONTEXT_DEFAULTS: Readonly<
  Record<string, (ctx: CliConfigKeyContext) => unknown>
> = {
  project_id: (ctx) => sanitizeProjectId(ctx.path.basename(ctx.workdir)),
  "auth.email.smtp.enabled": (ctx) => ctx.configAt("auth.email.smtp") !== undefined,
};

/** Optional leaves the stack config always carries as strings, so an unset value reads as `""`. */
export const CLI_CONFIG_EMPTY_DEFAULTS = /^auth\.hook\.[^.]+\.(uri|secrets)$/;

/** Canonical flag names (and short aliases) that override a key; `key.flag` accepts only these. */
export const CLI_CONFIG_FLAGS = {
  "linkedDb.password": { names: ["password"], aliases: ["p"] },
  "db.seed.enabled": { names: ["include-seed", "no-seed"] },
  "db.seed.sql_paths": { names: ["sql-paths"] },
  "experimental.pgdelta.enabled": { names: ["use-pg-delta"] },
} as const satisfies Readonly<Record<string, CliConfigFlagDeclaration>>;

const prefixed = (ctx: CliConfigKeyContext, pattern: unknown): unknown =>
  typeof pattern === "string" ? resolveSeedSqlPath(ctx.path, pattern) : pattern;

/** Schema leaves whose resolved value is the raw one made relative to `supabase/`. */
export const CLI_CONFIG_NORMALIZERS: Readonly<
  Record<string, (value: unknown, ctx: CliConfigKeyContext) => unknown>
> = {
  "db.seed.sql_paths": (value, ctx) =>
    Array.isArray(value) ? value.map((item) => prefixed(ctx, item)) : value,
  "db.migrations.schema_paths": (value, ctx) =>
    Array.isArray(value) ? value.map((item) => prefixed(ctx, item)) : value,
  "experimental.pgdelta.declarative_schema_path": (value, ctx) => prefixed(ctx, value),
};

const SECTION_GATES: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [/^experimental\.webhooks\./, () => "experimental.webhooks"],
  [/^storage\.image_transformation\./, () => "storage.image_transformation"],
  [/^auth\.captcha\./, () => "auth.captcha"],
  [/^auth\.email\.smtp\./, () => "auth.email.smtp"],
  [/^auth\.hook\.([^.]+)\./, (match) => `auth.hook.${match[1]}`],
  [/^auth\.sms\.(twilio_verify|messagebird|textlocal|vonage)\./, (match) => `auth.sms.${match[1]}`],
  [/^auth\.passkey\./, () => "auth.passkey"],
  [/^auth\.webauthn\./, () => "auth.webauthn"],
  [/^auth\.external\.(?!apple\.)([^.]+)\./, (match) => `auth.external.${match[1]}`],
];

/** The optional section a key's env override requires, when its path sits under one. */
export const envRequiresSectionFor = (path: string): string | undefined => {
  for (const [pattern, section] of SECTION_GATES) {
    const match = pattern.exec(path);
    if (match !== null) return section(match);
  }
  return undefined;
};

/** Keys read from the raw document that the schema does not model. */
export const CLI_CONFIG_DOCUMENT_KEYS: ReadonlyArray<CliConfigKeyDef> = [
  {
    path: "db.password",
    codec: stringCodec,
    default: DEFAULT_LOCAL_DATABASE_PASSWORD,
    noEnv: true,
  },
  {
    path: "db.root_key",
    codec: stringCodec,
    default: DEFAULT_POSTGRES_ROOT_KEY,
    secret: true,
  },
  { path: "auth.external_url", codec: stringCodec, optional: true },
  { path: "auth.passkey.enabled", codec: goBoolCodec, default: false },
  { path: "auth.webauthn.rp_id", codec: stringCodec, default: "" },
  { path: "auth.webauthn.rp_display_name", codec: stringCodec, default: "" },
  { path: "auth.webauthn.rp_origins", codec: commaListCodec, default: [] },
];

/** Keys with no document path: the linked project's database password. */
export const CLI_CONFIG_LINKED_KEYS: ReadonlyArray<CliConfigKeyDef> = [
  {
    path: "linkedDb.password",
    codec: stringCodec,
    optional: true,
    env: ["SUPABASE_DB_PASSWORD"],
    document: false,
    envScope: "linkedTarget",
  },
];

interface CliConfigFamilyField {
  readonly name: string;
  readonly codec: CliConfigCodec<unknown>;
  readonly optional?: true;
  readonly default?: unknown;
  readonly secret?: true;
}

export type CliConfigFamilyId =
  | "authExternal"
  | "authEmailTemplate"
  | "authEmailNotification"
  | "authHook";

export interface CliConfigFamilyDef {
  readonly id: CliConfigFamilyId;
  /** Dotted path of the table whose entries are named by the family. */
  readonly prefix: string;
  readonly fields: ReadonlyArray<CliConfigFamilyField>;
}

/** Tables keyed by an arbitrary name; env names are `SUPABASE_` + the path with the name upper-cased. */
export const CLI_CONFIG_FAMILIES: ReadonlyArray<CliConfigFamilyDef> = [
  {
    id: "authExternal",
    prefix: "auth.external",
    fields: [
      { name: "enabled", codec: goBoolCodec, default: false },
      { name: "client_id", codec: stringCodec, default: "" },
      { name: "secret", codec: stringCodec, optional: true, secret: true },
      { name: "url", codec: stringCodec, default: "" },
      { name: "redirect_uri", codec: stringCodec, default: "" },
      { name: "skip_nonce_check", codec: goBoolCodec, default: false },
      { name: "email_optional", codec: goBoolCodec, default: false },
    ],
  },
  {
    id: "authEmailTemplate",
    prefix: "auth.email.template",
    fields: [
      { name: "subject", codec: stringCodec, optional: true },
      { name: "content_path", codec: stringCodec, default: "" },
      { name: "content", codec: stringCodec, optional: true },
    ],
  },
  {
    id: "authEmailNotification",
    prefix: "auth.email.notification",
    fields: [
      { name: "enabled", codec: goBoolCodec, default: false },
      { name: "subject", codec: stringCodec, optional: true },
      { name: "content_path", codec: stringCodec, default: "" },
      { name: "content", codec: stringCodec, optional: true },
    ],
  },
  {
    id: "authHook",
    prefix: "auth.hook",
    fields: [
      { name: "enabled", codec: goBoolCodec, default: false },
      { name: "uri", codec: stringCodec, default: "" },
      { name: "secrets", codec: stringCodec, default: "", secret: true },
    ],
  },
];

/**
 * `SUPABASE_*` variables the CLI reads that are not config overrides, with their owner. A derived
 * config env name must never equal one of these.
 */
export const CLI_NON_CONFIG_ENV_NAMES: Readonly<Record<string, string>> = {
  SUPABASE_ACCESS_TOKEN: "platform auth",
  SUPABASE_ACTIVE_HELP: "shell completion",
  SUPABASE_ANON_KEY: "functions runtime env",
  SUPABASE_API_URL: "platform profile",
  SUPABASE_BASELINE: "pgdata snapshot marker file name",
  SUPABASE_CA_SKIP_VERIFY: "telemetry signal",
  SUPABASE_CLI_BINARY_OVERRIDE: "launcher",
  SUPABASE_CLI_VERSION: "build-time define",
  SUPABASE_CLI_POSTHOG_HOST: "telemetry",
  SUPABASE_CLI_POSTHOG_KEY: "telemetry",
  SUPABASE_COMPLETION_DESCRIPTIONS: "shell completion",
  SUPABASE_DASHBOARD_URL: "platform profile",
  SUPABASE_DB_URL: "functions runtime env",
  SUPABASE_DEBUG: "global flag",
  SUPABASE_ENV: "dotenv file selector",
  SUPABASE_EXPERIMENTAL: "global flag",
  SUPABASE_FOO_BAR: "documentation example",
  SUPABASE_FUNCTIONS_DIR: "functions deploy constant",
  SUPABASE_FUNCTIONS_SERVE_MAIN_TEMPLATE: "functions serve",
  SUPABASE_FUNCTION_SLUG: "functions runtime env",
  SUPABASE_HOME: "global state directory",
  SUPABASE_INSTALL_METHOD: "upgrade notice",
  SUPABASE_INTERNAL_DEBUG: "internal",
  SUPABASE_INTERNAL_FUNCTIONS_CONFIG: "internal",
  SUPABASE_INTERNAL_HOST_PORT: "internal",
  SUPABASE_INTERNAL_IMAGE_REGISTRY: "internal",
  SUPABASE_INTERNAL_JWT_SECRET: "internal",
  SUPABASE_INTERNAL_PUBLISHABLE_KEY: "internal",
  SUPABASE_INTERNAL_SECRET_KEY: "internal",
  SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC: "internal",
  SUPABASE_JWKS: "functions runtime env",
  SUPABASE_JWT_SECRET: "functions runtime env",
  SUPABASE_NETWORK_ID: "global flag",
  SUPABASE_NO_KEYRING: "credential storage",
  SUPABASE_NO_UPDATE_NOTIFIER: "upgrade notice",
  SUPABASE_OTLP_ENDPOINT: "telemetry",
  SUPABASE_OTLP_HEADERS: "telemetry",
  SUPABASE_POSTGRES_URL: "functions runtime env",
  SUPABASE_PROFILE: "platform profile",
  SUPABASE_PROJECT_HOST: "platform profile",
  SUPABASE_PUBLIC_URL: "functions runtime env",
  SUPABASE_PUBLISHABLE_KEY: "functions runtime env",
  SUPABASE_PUBLISHABLE_KEYS: "functions runtime env",
  SUPABASE_SCANNER_BUFFER_SIZE: "seed scanner",
  SUPABASE_SECRET_KEY: "functions runtime env",
  SUPABASE_SECRET_KEYS: "functions runtime env",
  SUPABASE_SERVICES_HOSTNAME: "functions runtime env",
  SUPABASE_SERVICE_KEY: "functions runtime env",
  SUPABASE_SERVICE_ROLE_KEY: "functions runtime env",
  SUPABASE_SHADOW_CACHE: "shadow database cache",
  SUPABASE_SHADOW_DEBUG: "shadow database",
  SUPABASE_SSL_DEBUG: "telemetry signal",
  SUPABASE_TELEMETRY_DEBUG: "telemetry",
  SUPABASE_TELEMETRY_DISABLED: "telemetry",
  SUPABASE_TELEMETRY_POSTHOG_HOST: "telemetry",
  SUPABASE_TELEMETRY_POSTHOG_KEY: "telemetry",
  SUPABASE_TRACE_FILE: "telemetry",
  SUPABASE_URL: "functions runtime env",
  SUPABASE_USE_SLIM_IMAGES: "image selection",
  SUPABASE_WORKDIR: "global flag",
  SUPABASE_YES: "global flag",
};
