import { Effect, FileSystem, Option, Path } from "effect";
import type { CliConfigFlagDeclaration } from "../config/cli-config-flags.ts";
import type { CliConfigKey } from "../config/cli-config-key.ts";
import { envReferenceNames } from "../config/cli-config-document.ts";
import { CliConfigKeys } from "../config/cli-config-keys.ts";
import { CliConfigValues } from "../config/cli-config-values.service.ts";
import { loadCliProjectEnvFiles } from "../shared/config/cli-config-env.ts";
import {
  makeCliConfigUnitIo,
  runConfigUnitsFirst,
  untrackedCliConfigView,
} from "./config-check-core.ts";
import { DB_CHECK_ORDER } from "./config-check-units.ts";
import { type ConfigFileRef, configFileRefOf } from "./config-advice.ts";
import { DbConfigLoadError, isPassthroughLoadFailure } from "./db-config.errors.ts";
import { recordOrioleDbTelemetry, selectsOrioleDb } from "./db-image.ts";
import { decryptSecret, isEncryptedSecret } from "../shared/config/vault-decrypt.ts";

/** Resolves a config `env(VAR)` reference: shell env first, then project `.env`. */
type EnvLookup = (name: string) => string | undefined;

/**
 * Subset of `supabase/config.toml` the db-config resolver needs. A missing config file yields
 * defaults; a malformed one aborts the command instead of running against the default local
 * database.
 */
export interface DbConfigValues {
  readonly projectEnv: Readonly<Record<string, string>>;
  readonly apiSchemas: ReadonlyArray<string>;
  /** Schemas the Data API serves; empty when `[api].enabled` is false. */
  readonly exposedSchemas: ReadonlyArray<string>;
  /** `[db] port`, default 54322 (`packages/config/src/db.ts`). */
  readonly port: number;
  /** `[db] shadow_port`, default 54320. */
  readonly shadowPort: number;
  /** `[db] password`, runtime default `"postgres"` (not in the config schema). */
  readonly password: string;
  /** The resolved, sanitized `project_id` (flag, env, config, then the workdir name). */
  readonly projectId: string;
  /** `[db] major_version`, default 17. */
  readonly majorVersion: number;
  /** `[db] orioledb_version` (env-expanded); set on a 15/17 project it rewrites the Postgres image to the OrioleDB tag. */
  readonly orioledbVersion: Option.Option<string>;
  /** `[edge_runtime] deno_version`, default 2; `1` selects the `deno1` image. */
  readonly denoVersion: number;
  /** `[experimental.pgdelta]` config for the declarative-schema commands. */
  readonly pgDelta: PgDeltaConfig;
  /** Effective `[experimental.webhooks].enabled`; false when the section is absent. */
  readonly webhooksEnabled: boolean;
  /** Config that shapes the shadow-database baseline; drift must invalidate the declarative catalog-cache key (`setupInputsToken`). */
  readonly baseline: BaselineConfig;
  /** `[db.migrations] enabled` (default true) — gates `up`/`down` migration apply. */
  readonly migrationsEnabled: boolean;
  /** `[db.migrations] schema_paths`, `supabase/`-prefixed when relative; resolved even when `migrationsEnabled` is false. */
  readonly schemaPaths: ReadonlyArray<string>;
  /** {@link schemaPaths} without the `supabase/` prefix, for callers that join it themselves. */
  readonly schemaPathPatterns: ReadonlyArray<string>;
  /** `[db.seed]` enabled + supabase-prefixed `sql_paths` globs — used by `down`. */
  readonly seed: DbSeedConfig;
  /** `[db.vault]` secrets (name → resolved value) — upserted by `up`/`down`. */
  readonly vault: ReadonlyArray<DbVaultSecret>;
  /** The `[remotes.<name>]` block a linked ref merged, if any. */
  readonly appliedRemote: string | undefined;
  /** The config file the values came from, for messages that point at it. */
  readonly configFile: ConfigFileRef;
}

/** `[db.seed]` config surfaced for `migration down`'s seed step. */
interface DbSeedConfig {
  readonly enabled: boolean;
  /** Glob patterns, each supabase-prefixed when relative. */
  readonly sqlPaths: ReadonlyArray<string>;
}

/** A `[db.vault]` secret; `value` is env-expanded and decrypted, `resolved` once it is a non-empty, non-`env(...)` string. */
interface DbVaultSecret {
  readonly name: string;
  readonly value: string;
  readonly resolved: boolean;
}

/** Cache-key inputs from `[auth]`/`[storage]`/`[realtime]`/`[api]`/`[db.vault]`. */
interface BaselineConfig {
  /** `[auth] enabled`, default true. Gates `initSchema`'s auth service migration. */
  readonly authEnabled: boolean;
  /** `[storage] enabled`, default true. */
  readonly storageEnabled: boolean;
  /** `[realtime] enabled`, default true. */
  readonly realtimeEnabled: boolean;
  /** `[api] auto_expose_new_tables`, tri-state; the cache key folds unset and `true` together. */
  readonly apiAutoExposeNewTables: Option.Option<boolean>;
  /** `[db.vault]` secret names (sorted), created during setup. */
  readonly vaultNames: ReadonlyArray<string>;
}

/** The `[experimental.pgdelta]` subtree. */
export interface PgDeltaConfig {
  /** `[experimental.pgdelta] enabled`, default true. */
  readonly enabled: boolean;
  /** `[experimental.pgdelta] declarative_schema_path`, `supabase/`-prefixed when relative; `None` means `resolveDeclarativeDir`'s default. */
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

/** Expands an `env(VAR)` string when the variable is set and non-empty; otherwise the value is kept as written. */
function expandEnv(value: string, lookup: (name: string) => string | undefined): string {
  const name = envRefName(value);
  if (name === undefined) return value;
  return envRefValue(value, lookup(name));
}

/** The project `.env*` values the shell does not already set. */
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
 * Dotted paths of every secret-typed field that must be decryptable; `*` matches any map key.
 * `[db.vault]` is listed because `config push` has no downstream vault pass. Update with any new secret field.
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
 * Asserts every `encrypted:` value at a {@link SECRET_PATHS} location, in the merged config and
 * each remote, can be decrypted. Remotes are checked only while `doc` still has its `remotes` key.
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

const toDbConfigLoadError = (error: ResolvedConfigLoadError) => {
  if (isPassthroughLoadFailure(error)) return error;
  switch (error._tag) {
    case "CliConfigParseError":
      return new DbConfigLoadError({ message: parseErrorMessage(error.cause) });
    case "PlatformError":
      return new DbConfigLoadError({ message: `failed to read file config: ${error.message}` });
    default:
      return new DbConfigLoadError({ message: error.message });
  }
};

const loadDbResolvedConfig = (
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

/** Projects the resolved project config onto {@link DbConfigValues}; fails with `DbConfigLoadError` when a present config is unreadable or invalid. */
const readDbConfigCore = Effect.fnUntraced(function* (
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
  const resolvedConfig = yield* loadDbResolvedConfig(workdir, ref, ignoreConfigFile);
  const projectEnv = resolvedConfig.projectEnvValues;
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

  const webhooksEnabled = config.experimental.webhooks?.enabled ?? false;
  const pgDeltaConfig = config.experimental.pgdelta;
  const declarativeSchemaPath = nonEmptyString(pgDeltaConfig?.declarative_schema_path);
  const formatOptions = nonEmptyString(pgDeltaConfig?.format_options);

  const configFile = configFileRefOf(path, workdir, resolvedConfig);
  const io = yield* makeCliConfigUnitIo("db").pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
  );
  yield* runConfigUnitsFirst(
    DB_CHECK_ORDER,
    untrackedCliConfigView({
      config,
      document: declaredDocument,
      workdir,
      configPath: configFile.path,
    }),
    io,
  ).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.mapError((cause) => new DbConfigLoadError({ message: causeMessage(cause) })),
  );

  const vaultConfig = config.db.vault ?? {};
  const vaultNames = Object.keys(vaultConfig).sort();
  const vault: Array<DbVaultSecret> = [];
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

  const apiSchemas = config.api.schemas;
  const exposedSchemas = config.api.enabled
    ? [...new Set(apiSchemas.map((schema) => schema.trim()).filter((schema) => schema.length > 0))]
    : [];

  const values: DbConfigValues = {
    projectEnv,
    apiSchemas,
    exposedSchemas,
    port,
    shadowPort,
    password: (yield* getKey(CliConfigKeys.db.password)).value,
    projectId,
    majorVersion,
    orioledbVersion,
    denoVersion,
    pgDelta: {
      enabled: (yield* getKey(CliConfigKeys.experimental.pgdelta.enabled)).value,
      declarativeSchemaPath,
      formatOptions,
    },
    webhooksEnabled,
    baseline: {
      authEnabled: config.auth.enabled,
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
    configFile,
  };
  return values;
});

/** Reads and validates the config: an absent file yields defaults, a present invalid one aborts. Call before any destructive work. */
export const checkDbConfig = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  ref?: string,
  // Pass `false` only when an earlier call in the same invocation already printed the OrioleDB S3 warning.
  opts?: {
    readonly warnOnUnresolvedEnv?: boolean;
    /** Skip resolving `[db.vault]` values while validating the rest of the config. */
    readonly resolveVaultSecrets?: boolean;
  },
) =>
  readDbConfigCore(
    fs,
    path,
    workdir,
    ref,
    false,
    opts?.warnOnUnresolvedEnv ?? true,
    opts?.resolveVaultSecrets ?? true,
  );

/** Validates like {@link checkDbConfig}; `{ validate: false }` never throws and falls back to defaults on a load failure. */
export const readDbConfig = (
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
    ? readDbConfigCore(
        fs,
        path,
        workdir,
        ref,
        false,
        warnOnUnresolvedEnv,
        resolveVaultSecrets,
      ).pipe(
        Effect.catchTags({
          DbConfigLoadError: () =>
            readDbConfigCore(
              fs,
              path,
              workdir,
              ref,
              true,
              warnOnUnresolvedEnv,
              resolveVaultSecrets,
            ),
          CliConfigValueError: () =>
            readDbConfigCore(
              fs,
              path,
              workdir,
              ref,
              true,
              warnOnUnresolvedEnv,
              resolveVaultSecrets,
            ),
        }),
      )
    : readDbConfigCore(fs, path, workdir, ref, false, warnOnUnresolvedEnv, resolveVaultSecrets);
};

/** The configured `declarative_schema_path` or the default `supabase/schemas`, joined with the host separator. */
export function resolveDeclarativeDir(path: Path.Path, pgDelta: PgDeltaConfig): string {
  return Option.getOrElse(pgDelta.declarativeSchemaPath, () =>
    path.join(...DEFAULT_DECLARATIVE_DIR_SEGMENTS),
  );
}
