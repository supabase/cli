import { Effect, FileSystem, Option, Path } from "effect";
import type { CliConfigFlagDeclaration } from "../config/cli-config-flags.ts";
import type { CliConfigKey } from "../config/cli-config-key.ts";
import { envReferenceNames } from "../config/cli-config-document.ts";
import { CliConfigKeys, cliConfigFamilyKey, cliConfigRegistry } from "../config/cli-config-keys.ts";
import { CliConfigValues } from "../config/cli-config-values.service.ts";
import { loadCliProjectEnvFiles } from "../shared/config/cli-config-env.ts";
import {
  type AnalyticsInput,
  type AuthInput,
  type CaptchaInput,
  type ConfigValidationInput,
  emailContentPathReadErrorMessage,
  type ExperimentalInput,
  type HookInput,
  type MfaFactorInput,
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
import { recordOrioleDbTelemetry, selectsOrioleDb } from "./db-image.ts";
import { ramInBytes } from "./size-units.ts";
import { resolveSmtpEnabled } from "./smtp-enabled.ts";
import { decryptSecret, isEncryptedSecret } from "../shared/config/vault-decrypt.ts";

/** Resolves a config `env(VAR)` reference: shell env first, then project `.env`. */
type EnvLookup = (name: string) => string | undefined;

/**
 * Subset of `supabase/config.toml` (plus the linked pooler URL) the db-config
 * resolver needs. A missing config file yields defaults; a malformed one aborts
 * the command instead of running against the default local database.
 */
export interface DbTomlValues {
  readonly projectEnv: Readonly<Record<string, string>>;
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
  /** The resolved, sanitized `project_id` (flag, env, config, then the workdir name). */
  readonly projectId: string;
  /** `[db] major_version`, default 17. */
  readonly majorVersion: number;
  /**
   * `[db] orioledb_version` (env-expanded); the deprecated `[experimental] orioledb_version` is
   * already promoted into this path by `normalizeDeprecatedOrioleDBVersion`. Set on a 15/17
   * project to rewrite the Postgres image to the OrioleDB tag; `None` for a vanilla project.
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

/** Default declarative schema dir. */
const DEFAULT_DECLARATIVE_DIR_SEGMENTS = ["supabase", "schemas"] as const;

type RawDoc = { readonly [key: string]: unknown };

function asRecord(value: unknown): RawDoc | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawDoc)
    : undefined;
}

const ENV_PATTERN = /^env\((.*)\)$/;

function envRefName(value: string): string | undefined {
  const matches = ENV_PATTERN.exec(value);
  return matches === null ? undefined : (matches[1] ?? "");
}

function envRefValue(literal: string, resolved: string | undefined): string {
  return resolved !== undefined && resolved.length > 0 ? resolved : literal;
}

/**
 * Expand `env(VAR)` config form: a string matching `^env\((.*)\)$` resolves to
 * the named environment variable, but only when that variable is set and
 * non-empty; otherwise the literal value is preserved unchanged. `lookup`
 * resolves the name against the shell environment first and then the project
 * `.env` files.
 */
function expandEnv(value: string, lookup: (name: string) => string | undefined): string {
  const name = envRefName(value);
  if (name === undefined) return value;
  return envRefValue(value, lookup(name));
}

/**
 * The project `.env*` values the shell does not already set, for handlers that resolve global
 * flags such as `--yes` against them.
 */
export const loadProjectEnvValues = (fs: FileSystem.FileSystem, path: Path.Path, workdir: string) =>
  loadCliProjectEnvFiles(workdir).pipe(
    Effect.map((loaded) => ({ ...loaded.values })),
    Effect.mapError((cause) => new DbConfigLoadError({ message: cause.message })),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );

function nonEmptyString(value: unknown): Option.Option<string> {
  return typeof value === "string" && value.length > 0 ? Option.some(value) : Option.none();
}

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

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.length === 0 ? undefined : value;

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const parseErrorMessage = (cause: unknown): string => {
  const detail = causeMessage(cause);
  const head = detail.split("\n  at ")[0] ?? detail;
  return /^(Missing required|Invalid (?!TOML|JSON))/.test(head)
    ? head
    : `failed to load config: ${detail}`;
};

type ResolvedConfigLoadError = Effect.Error<ReturnType<CliConfigValues["Service"]["load"]>>;

const toDbConfigLoadError = (error: ResolvedConfigLoadError): DbConfigLoadError => {
  switch (error._tag) {
    case "CliConfigParseError":
      return new DbConfigLoadError({ message: parseErrorMessage(error.cause) });
    case "PlatformError":
      return new DbConfigLoadError({ message: `failed to read file config: ${error.message}` });
    default:
      return new DbConfigLoadError({ message: error.message });
  }
};

const loadDbTomlResolvedConfig = (
  workdir: string,
  ref: string | undefined,
  ignoreConfigFile: boolean,
) =>
  CliConfigValues.use((values) =>
    values.load({
      workdir,
      projectRef: Option.fromNullishOr(ref),
      ...(ignoreConfigFile ? { ignoreConfigFile: true as const } : {}),
    }),
  ).pipe(Effect.mapError(toDbConfigLoadError));

/**
 * Projects the `CliConfigValues` resolved config of `<workdir>/supabase/config.{toml,json}` (flags aside)
 * and the linked `<workdir>/supabase/.temp/pooler-url` onto {@link DbTomlValues}. `fs`/`path` are
 * passed in so the resolver can capture them once and keep its own `R` at `never`.
 *
 * Fails with `DbConfigLoadError` when the config is present but unreadable, undecodable or invalid;
 * an absent file (and an absent/empty pooler-url file) is not an error.
 */
const readDbTomlCore = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  // The `[remotes.<name>]` block whose `project_id` equals `ref` is the config-tier overlay;
  // omitted for `--local`/`--db-url`/declarative.
  ref?: string,
  // The config file is treated as absent: the fallback after a load failure for `validate: false`.
  ignoreConfigFile = false,
  // Gates the OrioleDB S3 unresolved-env WARN so it prints once per command invocation.
  warnOnUnresolvedEnv = true,
  resolveVaultSecrets = true,
) {
  const supabaseDir = path.join(workdir, "supabase");
  const resolvedConfig = yield* loadDbTomlResolvedConfig(workdir, ref, ignoreConfigFile);
  const withheldNames = new Set(resolvedConfig.withheldEnv.map((held) => held.envName));
  const projectEnv = Object.fromEntries(
    Object.entries(resolvedConfig.projectEnvValues).filter(([name]) => !withheldNames.has(name)),
  );
  const { config } = resolvedConfig.materialized;
  const fail = (message: string) => Effect.fail(new DbConfigLoadError({ message }));
  const getKey = <A, X, F extends CliConfigFlagDeclaration>(key: CliConfigKey<A, X, F>) =>
    resolvedConfig.get(key).pipe(Effect.mapError(toDbConfigLoadError));

  const declaredDocument = resolvedConfig.loaded.document ?? {};
  const secretDocument = Object.fromEntries(
    ["db", "auth", "studio", "edge_runtime", "remotes"].map((key) => [key, declaredDocument[key]]),
  );
  const referenced = yield* resolvedConfig
    .envValues(envReferenceNames(secretDocument))
    .pipe(Effect.mapError(toDbConfigLoadError));
  const lookup: EnvLookup = (name) => referenced[name];
  const secretError = assertDecryptableSecrets(
    secretDocument,
    lookup,
    resolvedConfig.dotenvPrivateKeys,
    {
      includeVault: resolveVaultSecrets,
    },
  );
  if (secretError !== undefined) return yield* fail(secretError);

  const poolerUrlPath = path.join(supabaseDir, ".temp", "pooler-url");
  const poolerConnectionString = yield* fs
    .readFileString(poolerUrlPath)
    .pipe(Effect.map(nonEmptyString), Effect.orElseSucceed(Option.none<string>));

  const configuredProjectId = yield* getKey(CliConfigKeys.projectId);
  if (
    configuredProjectId.origin.tier !== "default" &&
    (configuredProjectId.unnormalized ?? configuredProjectId.value) === ""
  ) {
    return yield* fail("Missing required field in config: project_id");
  }
  const projectId = configuredProjectId.value;

  const { port, shadow_port: shadowPort, major_version: majorVersion } = config.db;
  if (port === 0) return yield* fail("Missing required field in config: db.port");

  const orioledbVersion = nonEmptyString(config.db.orioledb_version);
  if (!ignoreConfigFile) {
    yield* recordOrioleDbTelemetry(Option.getOrUndefined(orioledbVersion), majorVersion);
  }
  if (
    selectsOrioleDb(Option.getOrUndefined(orioledbVersion), majorVersion) &&
    warnOnUnresolvedEnv
  ) {
    for (const field of ["s3_host", "s3_region", "s3_access_key", "s3_secret_key"] as const) {
      const unset = ENV_PATTERN.exec(config.experimental[field] ?? "");
      if (unset !== null) {
        process.stderr.write(`WARN: environment variable is unset: ${unset[1] ?? ""}\n`);
      }
    }
  }

  const denoVersion = config.edge_runtime.deno_version;

  const webhooksPresent = resolvedConfig.declares("experimental.webhooks");
  const webhooksEnabled = config.experimental.webhooks?.enabled ?? false;
  const pgDeltaConfig = config.experimental.pgdelta;
  const declarativeSchemaPath = nonEmptyString(pgDeltaConfig?.declarative_schema_path);
  const formatOptions = nonEmptyString(pgDeltaConfig?.format_options);

  const buckets = config.storage.buckets ?? {};
  for (const [bucketName, bucket] of Object.entries(buckets)) {
    try {
      ramInBytes(bucket.file_size_limit);
    } catch {
      return yield* fail(
        `failed to parse config: invalid storage.buckets.${bucketName}.file_size_limit.`,
      );
    }
  }

  const authEnabled = config.auth.enabled;
  const { auth } = config;

  let authInput: AuthInput | undefined;
  if (authEnabled) {
    const captcha = auth.captcha;
    const captchaInput: CaptchaInput | undefined =
      captcha === undefined
        ? undefined
        : {
            enabled: captcha.enabled,
            provider: nonEmpty(captcha.provider),
            secret: nonEmpty(captcha.secret),
          };

    const signingKeysPath = auth.signing_keys_path ?? "";
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

    let passkeyInput: PasskeyInput | undefined;
    if ((yield* getKey(CliConfigKeys.auth.passkey.enabled)).value) {
      const rpOrigins = (yield* getKey(CliConfigKeys.auth.webauthn.rpOrigins)).value;
      passkeyInput = {
        webauthnPresent: resolvedConfig.declares("auth.webauthn"),
        rpId: (yield* getKey(CliConfigKeys.auth.webauthn.rpId)).value,
        rpOrigins: rpOrigins.length > 0 ? rpOrigins : undefined,
      };
    }

    const hooks: Array<HookInput> = [];
    for (const type of [
      "mfa_verification_attempt",
      "password_verification_attempt",
      "custom_access_token",
      "send_sms",
      "send_email",
      "before_user_created",
    ] as const) {
      const hook = auth.hook[type];
      if (hook.enabled) hooks.push({ type, uri: hook.uri ?? "", secrets: hook.secrets ?? "" });
    }

    const mfa: Array<MfaFactorInput> = (["totp", "phone", "web_authn"] as const).map((label) => ({
      label,
      enrollEnabled: auth.mfa[label].enroll_enabled,
      verifyEnabled: auth.mfa[label].verify_enabled,
    }));

    const emailContentPath = Effect.fnUntraced(function* (
      section: "template" | "notification",
      name: string,
      entry: { readonly content_path?: string },
    ) {
      const family = cliConfigRegistry.families.find(
        (candidate) =>
          candidate.id === (section === "template" ? "authEmailTemplate" : "authEmailNotification"),
      );
      const contentKey =
        family === undefined ? undefined : cliConfigFamilyKey(family, name, "content");
      const contentPresent =
        contentKey !== undefined && (yield* getKey(contentKey)).origin.tier !== "default";
      return yield* Effect.try({
        try: () =>
          resolveEmailTemplateContentPath({
            section,
            name,
            contentPath: entry.content_path ?? "",
            contentPresent,
            base: workdir,
          }),
        catch: (cause) => new DbConfigLoadError({ message: causeMessage(cause) }),
      });
    });
    for (const [name, template] of Object.entries(auth.email.template)) {
      const contentPath = yield* emailContentPath("template", name, template);
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
    for (const [name, notification] of Object.entries(auth.email.notification)) {
      if (!notification.enabled) continue;
      const contentPath = yield* emailContentPath("notification", name, notification);
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

    const smtp = auth.email.smtp;
    const smtpInput: SmtpInput | undefined =
      smtp === undefined
        ? undefined
        : {
            enabled: resolveSmtpEnabled(resolvedConfig),
            host: smtp.host ?? "",
            port: smtp.port ?? 0,
            user: smtp.user ?? "",
            pass: smtp.pass ?? "",
            adminEmail: smtp.admin_email ?? "",
          };

    const thirdPartyConfig = auth.third_party;
    const thirdParty: Array<ThirdPartyInput> = [];
    if (thirdPartyConfig.firebase.enabled) {
      thirdParty.push({
        provider: "firebase",
        requiredField: thirdPartyConfig.firebase.project_id ?? "",
      });
    }
    if (thirdPartyConfig.auth0.enabled) {
      thirdParty.push({ provider: "auth0", requiredField: thirdPartyConfig.auth0.tenant ?? "" });
    }
    if (thirdPartyConfig.aws_cognito.enabled) {
      thirdParty.push({
        provider: "cognito",
        requiredField: thirdPartyConfig.aws_cognito.user_pool_id ?? "",
        cognitoUserPoolRegion: thirdPartyConfig.aws_cognito.user_pool_region ?? "",
      });
    }
    if (thirdPartyConfig.clerk.enabled) {
      thirdParty.push({ provider: "clerk", requiredField: thirdPartyConfig.clerk.domain ?? "" });
    }
    if (thirdPartyConfig.workos.enabled) {
      thirdParty.push({
        provider: "workos",
        requiredField: thirdPartyConfig.workos.issuer_url ?? "",
      });
    }

    authInput = {
      siteUrl: auth.site_url,
      captcha: captchaInput,
      passkey: passkeyInput,
      hooks,
      mfa,
      smtp: smtpInput,
      thirdParty,
    };
  }

  const { analytics } = config;
  const analyticsInput: AnalyticsInput = {
    enabled: analytics.enabled,
    backend: nonEmpty(analytics.backend),
    gcpProjectId: analytics.gcp_project_id ?? "",
    gcpProjectNumber: analytics.gcp_project_number ?? "",
    gcpJwtPath: analytics.gcp_jwt_path ?? "",
  };
  const experimentalInput: ExperimentalInput = {
    webhooksPresent,
    webhooksEnabled,
    pgdeltaFormatOptions: pgDeltaConfig?.format_options ?? "",
  };
  const validationInput: ConfigValidationInput = {
    db: { port, majorVersion },
    storageBucketNames: Object.keys(buckets),
    functionSlugs: Object.keys(config.functions ?? {}),
    auth: authInput,
    edgeRuntimeDenoVersion: denoVersion,
    analytics: analyticsInput,
    experimental: experimentalInput,
  };
  yield* Effect.try({
    try: () => validateResolvedConfig(validationInput),
    catch: (cause) => new DbConfigLoadError({ message: causeMessage(cause) }),
  });

  if (authEnabled) {
    const sms = auth.sms;
    const smsProviders = [
      {
        enabled: sms.twilio.enabled,
        fields: ["account_sid", "message_service_sid", "auth_token"],
        record: sms.twilio,
        name: "twilio",
      },
      {
        enabled: sms.twilio_verify.enabled,
        fields: ["account_sid", "message_service_sid", "auth_token"],
        record: sms.twilio_verify,
        name: "twilio_verify",
      },
      {
        enabled: sms.messagebird.enabled,
        fields: ["originator", "access_key"],
        record: sms.messagebird,
        name: "messagebird",
      },
      {
        enabled: sms.textlocal.enabled,
        fields: ["sender", "api_key"],
        record: sms.textlocal,
        name: "textlocal",
      },
      {
        enabled: sms.vonage.enabled,
        fields: ["from", "api_key", "api_secret"],
        record: sms.vonage,
        name: "vonage",
      },
    ];
    const activeSms = smsProviders.find((provider) => provider.enabled);
    if (activeSms !== undefined) {
      for (const field of activeSms.fields) {
        if (nonEmpty(asRecord(activeSms.record)?.[field] as string | undefined) === undefined) {
          return yield* fail(
            `Missing required field in config: auth.sms.${activeSms.name}.${field}`,
          );
        }
      }
    }

    for (const [name, provider] of Object.entries(auth.external)) {
      if (name === "linkedin" || name === "slack" || !provider.enabled) continue;
      if (nonEmpty(provider.client_id) === undefined) {
        return yield* fail(`Missing required field in config: auth.external.${name}.client_id`);
      }
      if (name !== "apple" && name !== "google" && nonEmpty(provider.secret) === undefined) {
        return yield* fail(`Missing required field in config: auth.external.${name}.secret`);
      }
    }
  }

  const vaultConfig = config.db.vault ?? {};
  const vaultNames = Object.keys(vaultConfig).sort();
  const vault: Array<DbVaultSecretToml> = [];
  if (resolveVaultSecrets) {
    for (const name of vaultNames) {
      const value = vaultConfig[name] ?? "";
      if (value.length === 0 || ENV_PATTERN.test(value)) {
        vault.push({ name, value, resolved: false });
        continue;
      }
      if (isEncryptedSecret(value)) {
        const decrypted = decryptSecret(value, resolvedConfig.dotenvPrivateKeys);
        if (!decrypted.ok) return yield* fail(`failed to parse config: ${decrypted.error}`);
        vault.push({ name, value: decrypted.value, resolved: true });
        continue;
      }
      vault.push({ name, value, resolved: true });
    }
  }

  const schemaPaths = yield* getKey(CliConfigKeys.db.migrations.schemaPaths);
  const seedEnabled = config.db.seed.enabled;
  const seedSqlPaths = (yield* getKey(CliConfigKeys.db.seed.sqlPaths)).value;

  const values: DbTomlValues = {
    projectEnv,
    apiSchemas: config.api.schemas,
    port,
    shadowPort,
    password: (yield* getKey(CliConfigKeys.db.password)).value,
    poolerConnectionString,
    projectId,
    majorVersion,
    orioledbVersion,
    denoVersion,
    pgDelta: {
      enabled: pgDeltaConfig?.enabled ?? false,
      declarativeSchemaPath,
      formatOptions,
    },
    webhooksEnabled,
    baseline: {
      authEnabled,
      storageEnabled: config.storage.enabled,
      realtimeEnabled: config.realtime.enabled,
      apiAutoExposeNewTables: Option.fromNullishOr(config.api.auto_expose_new_tables),
      vaultNames,
    },
    migrationsEnabled: config.db.migrations.enabled,
    schemaPaths: schemaPaths.value,
    schemaPathPatterns: schemaPaths.unnormalized ?? schemaPaths.value,
    seed: { enabled: seedEnabled, sqlPaths: seedSqlPaths },
    vault,
    appliedRemote: Option.getOrUndefined(resolvedConfig.appliedRemote),
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
