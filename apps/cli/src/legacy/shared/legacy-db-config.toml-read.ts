import { Effect, type FileSystem, Option, type Path } from "effect";
import * as SmolToml from "smol-toml";
import { LegacyDbConfigLoadError } from "./legacy-db-config.errors.ts";
import { parseDotEnv } from "./legacy-dotenv.ts";

/** Resolves a config `env(VAR)` reference: shell env first, then project `.env`. */
type EnvLookup = (name: string) => string | undefined;

/**
 * Subset of `supabase/config.toml` (plus the linked pooler URL) the db-config
 * resolver needs.
 *
 * Mirrors Go's `flags.LoadConfig` → `config.Load`
 * (`apps/cli-go/internal/utils/flags/config_path.go:10`,
 * `pkg/config/config.go`): a **missing** config file yields `config.NewConfig()`
 * defaults, but a **malformed** file is a hard error (Go returns the decode error
 * and aborts the command rather than running against the default local database).
 */
interface LegacyDbTomlValues {
  /** `[db] port`, default 54322 (`packages/config/src/db.ts`). */
  readonly port: number;
  /** `[db] shadow_port`, default 54320. */
  readonly shadowPort: number;
  /** `[db] password`, runtime default `"postgres"` (not in the config schema). */
  readonly password: string;
  /**
   * Linked connection pooler URL, used by the `--linked` pooler fallback. Written
   * by `supabase link` to `supabase/.temp/pooler-url` — Go reads it from there, not
   * from config.toml (the config field is tagged `toml:"-"`, `pkg/config/db.go:116`;
   * it is populated programmatically in `config.Load`, `config.go:626`).
   */
  readonly poolerConnectionString: Option.Option<string>;
  /** top-level `project_id`, used to name the local docker network. */
  readonly projectId: Option.Option<string>;
  /** `[db] major_version`, default 17 (`apps/cli-go/pkg/config/templates/config.toml:42`). */
  readonly majorVersion: number;
  /**
   * `[edge_runtime] deno_version`, default 2. Selects the edge-runtime image tag:
   * `1` → the `deno1` image, otherwise the default (Go's `config.go:999-1008`).
   */
  readonly denoVersion: number;
  /**
   * `[experimental.pgdelta]` config, consumed by the declarative-schema commands
   * (`db schema declarative generate` / `sync`). Mirrors Go's `PgDeltaConfig`
   * (`apps/cli-go/pkg/config/config.go:228-234`).
   */
  readonly pgDelta: LegacyPgDeltaTomlConfig;
  /**
   * The subset of config that shapes the shadow-database platform baseline and
   * therefore the declarative catalog-cache key (Go's `setupInputsToken`,
   * `apps/cli-go/internal/db/declarative/declarative.go:688`). Drift in any of
   * these must self-invalidate cached catalogs.
   */
  readonly baseline: LegacyBaselineTomlConfig;
}

/** Cache-key inputs from `[auth]`/`[storage]`/`[realtime]`/`[api]`/`[db.vault]`. */
interface LegacyBaselineTomlConfig {
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
 * `supabase/.temp/pgdelta-version` (not the TOML), matching Go's `config.Load`
 * (`config.go:700-709`).
 */
export interface LegacyPgDeltaTomlConfig {
  /** `[experimental.pgdelta] enabled`, default false. Go's `IsPgDeltaEnabled`. */
  readonly enabled: boolean;
  /**
   * `[experimental.pgdelta] declarative_schema_path`, resolved to a
   * `supabase/`-prefixed path when relative (Go's `config.resolve`,
   * `config.go:816-819`). `None` → callers use the default `supabase/database`
   * (`legacyResolveDeclarativeDir`).
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
/** `[edge_runtime] deno_version` default (`config.toml` template). 2 → v1.74.1. */
const DEFAULT_DENO_VERSION = 2;

/** Default declarative schema dir (`utils.DeclarativeDir`, `misc.go:102`). */
const DEFAULT_DECLARATIVE_DIR_SEGMENTS = ["supabase", "database"] as const;

type RawDoc = { readonly [key: string]: unknown };

function asRecord(value: unknown): RawDoc | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawDoc)
    : undefined;
}

/** Recursively merge `override` over `base` (nested tables merge, scalars/arrays
 * replace) — mirrors Go's per-key viper override (`config.go:550-562`). */
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
 * config (Go's `config.Load`, `config.go:503-518` + `mergeRemoteConfig`). The block
 * key name is only used for diagnostics in Go; the match is on `project_id`.
 */
function applyRemoteOverride(doc: RawDoc | undefined, ref: string): RawDoc | undefined {
  const remotes = asRecord(doc?.["remotes"]);
  if (doc === undefined || remotes === undefined) return doc;
  for (const name of Object.keys(remotes)) {
    const block = asRecord(remotes[name]);
    if (block === undefined) continue;
    if (typeof block["project_id"] === "string" && block["project_id"] === ref) {
      return deepMergeDoc(doc, block);
    }
  }
  return doc;
}

const ENV_PATTERN = /^env\((.*)\)$/;

/**
 * Expand Go's `env(VAR)` config form. Mirrors `LoadEnvHook`
 * (`apps/cli-go/pkg/config/decode_hooks.go`): a string matching `^env\((.*)\)$`
 * resolves to the named environment variable, but only when that variable is set
 * and non-empty; otherwise the literal value is preserved unchanged (Go's hook
 * keeps `value` when `len(os.Getenv(name)) == 0`). `lookup` resolves the name
 * against the shell environment first and then the project `.env` files, matching
 * Go's `loadNestedEnv` (which populates the process env before `LoadEnvHook`).
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

/** `[db]` ports decode into Go's `uint16` (`pkg/config/db.go:84-85`). */
const MAX_PORT = 65535;

/**
 * Resolve a `[db]` port field. Go decodes the TOML value into a `uint16`
 * (`config.Load` via `mapstructure`'s weakly-typed input, *after* `LoadEnvHook`
 * runs), so an `env(VAR)` reference written as a quoted string is expanded and
 * then parsed as the port. Parity rules:
 *
 * - **Omitted** (`undefined`) → the schema default.
 * - **Present and resolves to a `uint16`** (a plain integer in range, or an
 *   `env(VAR)` string that expands to one) → that value.
 * - **Present but cannot unmarshal** (non-numeric, negative, out of range, or an
 *   unresolved `env(VAR)`) → `undefined`, signalling the caller to abort with
 *   `LegacyDbConfigLoadError`. Go errors here rather than silently defaulting and
 *   running against the default local database while hiding a broken config.
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

/** `[db]` ports default through the development env unless `SUPABASE_ENV` overrides. */
const DEFAULT_SUPABASE_ENV = "development";

/**
 * Load the project's nested `.env` files into a lookup map, mirroring Go's
 * `loadNestedEnv` + `loadDefaultEnv` (`pkg/config/config.go:1047-1085`). Go walks
 * from the `supabase/` directory up to the repo root and, in each directory,
 * loads `.env.<env>.local`, `.env.local` (skipped when `SUPABASE_ENV=test`),
 * `.env.<env>`, then `.env` via `godotenv.Load`, which never overrides a value
 * already set. So the shell environment wins over the files, the `supabase/`
 * directory wins over the repo root, and earlier filenames win within a
 * directory. A malformed `.env` — or one that exists but cannot be read —
 * aborts: Go's `loadEnvIfExists` swallows only `os.ErrNotExist` and returns
 * every other error. The path is named without leaking file contents
 * (CWE-209-safe).
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

function nonEmptyString(value: unknown): Option.Option<string> {
  return typeof value === "string" && value.length > 0 ? Option.some(value) : Option.none();
}

/** Go's `json.Valid` (`encoding/json`): reports whether the string is well-formed JSON. */
function legacyIsValidJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a `[section] enabled` style bool. Go decodes weakly (a string `"true"`
 * via `env(VAR)` also counts) and applies the schema default when the key is
 * absent. `auth`/`storage`/`realtime` all default `true`.
 */
function resolveBool(value: unknown, fallback: boolean, lookup: EnvLookup): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return legacyExpandEnv(value, lookup) === "true";
  return fallback;
}

/**
 * Reads `<workdir>/supabase/config.toml` (db subtree + project id) and the linked
 * `<workdir>/supabase/.temp/pooler-url`. `fs`/`path` are passed in so the resolver
 * can capture them once and keep its own `R` at `never`.
 *
 * Fails with `LegacyDbConfigLoadError` only when the config file is present but
 * unparseable; an absent file (and an absent/empty pooler-url file) is not an error.
 */
export const legacyReadDbToml = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  // When set (the explicitly-linked path only), a `[remotes.<name>]` block whose
  // `project_id` equals `ref` is merged over the base config before fields are
  // read — Go's `config.Load` merge keyed on `Config.ProjectId` (config.go:503-562).
  // `--local` / `--db-url` / declarative pass nothing and read the unmerged config,
  // matching Go (those paths never resolve a ref before config load).
  ref?: string,
) {
  const supabaseDir = path.join(workdir, "supabase");
  const configPath = path.join(supabaseDir, "config.toml");

  // Distinguish "absent" (→ defaults) from "present but unreadable/malformed" (→ fail),
  // matching Go's `mergeFileConfig` (`pkg/config/config.go:528`): only `os.ErrNotExist`
  // is swallowed, every other read error aborts rather than silently running against the
  // default local database. Effect surfaces "not found" as `PlatformError` with a
  // `SystemError` reason tagged `"NotFound"`.
  const maybeContent = yield* fs.readFileString(configPath).pipe(
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

  let db: RawDoc | undefined;
  let pgDeltaRaw: RawDoc | undefined;
  let authRaw: RawDoc | undefined;
  let storageRaw: RawDoc | undefined;
  let realtimeRaw: RawDoc | undefined;
  let apiRaw: RawDoc | undefined;
  let edgeRuntimeRaw: RawDoc | undefined;
  let projectId = Option.none<string>();
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
    // Apply a matching `[remotes.<name>]` override (Go merges the block whose
    // `project_id` equals the resolved ref over the base, config.go:503-562).
    const effectiveDoc = ref === undefined ? doc : applyRemoteOverride(doc, ref);
    db = asRecord(effectiveDoc?.["db"]);
    pgDeltaRaw = asRecord(asRecord(effectiveDoc?.["experimental"])?.["pgdelta"]);
    authRaw = asRecord(effectiveDoc?.["auth"]);
    storageRaw = asRecord(effectiveDoc?.["storage"]);
    realtimeRaw = asRecord(effectiveDoc?.["realtime"]);
    apiRaw = asRecord(effectiveDoc?.["api"]);
    edgeRuntimeRaw = asRecord(effectiveDoc?.["edge_runtime"]);
    projectId = nonEmptyString(effectiveDoc?.["project_id"]);
  }

  // Go: `config.go:626` — read the linked pooler URL from `.temp/pooler-url` and
  // treat it as configured only when the file exists and is non-empty.
  const poolerUrlPath = path.join(supabaseDir, ".temp", "pooler-url");
  const poolerConnectionString = yield* fs
    .readFileString(poolerUrlPath)
    .pipe(Effect.map(nonEmptyString), Effect.orElseSucceed(Option.none<string>));

  // Go: `config.go:700-709` — the pg-delta npm version is read from
  // `.temp/pgdelta-version` (trimmed, non-empty) during Load, never from the
  // TOML. An absent/empty file leaves it `None` (callers fall back to the
  // default via `legacyEffectivePgDeltaNpmVersion`).
  const pgDeltaVersionPath = path.join(supabaseDir, ".temp", "pgdelta-version");
  const pgDeltaNpmVersion = yield* fs.readFileString(pgDeltaVersionPath).pipe(
    Effect.map((content) => nonEmptyString(content.trim())),
    Effect.orElseSucceed(Option.none<string>),
  );

  // Resolve `env(VAR)` against the shell env first, then the project `.env` files
  // (Go's `loadNestedEnv` populates the process env before `LoadEnvHook`).
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, workdir);
  const lookup: EnvLookup = (name) => process.env[name] ?? projectEnv[name];

  // Go's loader enables viper `SetEnvPrefix("SUPABASE")` + `EnvKeyReplacer(".",
  // "_")` + `AutomaticEnv()` (`config.go:487-492`), so `SUPABASE_DB_*` env vars
  // override the matching `[db]` field before the TOML value/default. viper
  // ignores empty env values (`AllowEmptyEnv` defaults false), and the project
  // `.env` files are loaded into the environment first, so consult both.
  const envOverride = (name: string): string | undefined => {
    const fromShell = process.env[name];
    if (fromShell !== undefined && fromShell.length > 0) return fromShell;
    const fromFile = projectEnv[name];
    return fromFile !== undefined && fromFile.length > 0 ? fromFile : undefined;
  };

  // A present-but-unmarshalable port aborts in Go rather than defaulting; mirror
  // that so `test db --local` never silently targets the default local database
  // while hiding a broken `[db]` config.
  const port = resolvePort(envOverride("SUPABASE_DB_PORT") ?? db?.["port"], DEFAULT_PORT, lookup);
  const shadowPort = resolvePort(
    envOverride("SUPABASE_DB_SHADOW_PORT") ?? db?.["shadow_port"],
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

  // Go's `db.Password` is tagged `json:"-"` (`apps/cli-go/pkg/config/db.go:88`), so
  // it is NOT bound from `SUPABASE_DB_PASSWORD` — the local password is the fixed
  // config value/`"postgres"` default. `DB_PASSWORD` is read only by linked password
  // resolution (`legacy-db-config.layer.ts`), so the local password must not source
  // it or `db query --local` etc. would authenticate with a remote secret.
  const passwordRaw = typeof db?.["password"] === "string" ? db["password"] : undefined;

  const majorVersionRaw = envOverride("SUPABASE_DB_MAJOR_VERSION") ?? db?.["major_version"];
  const majorVersionNum =
    typeof majorVersionRaw === "number"
      ? majorVersionRaw
      : typeof majorVersionRaw === "string"
        ? Number.parseInt(majorVersionRaw, 10)
        : Number.NaN;
  // Reject unsupported major versions like Go's config.Validate ({13,14,15,17};
  // `apps/cli-go/pkg/config/config.go:869-897`) before any image/container runs. An
  // absent/unparseable value falls through to the default (Go's zero-then-default).
  if (
    majorVersionRaw !== undefined &&
    Number.isInteger(majorVersionNum) &&
    ![13, 14, 15, 17].includes(majorVersionNum)
  ) {
    return yield* Effect.fail(
      new LegacyDbConfigLoadError({
        message:
          majorVersionNum === 12
            ? "Postgres version 12.x is unsupported. To use the CLI, either start a new project or follow project migration steps here: https://supabase.com/docs/guides/database#migrating-between-projects."
            : `Failed reading config: Invalid db.major_version: ${majorVersionNum}.`,
      }),
    );
  }
  const majorVersion = Number.isInteger(majorVersionNum) ? majorVersionNum : DEFAULT_MAJOR_VERSION;

  // `[edge_runtime] deno_version` (default 2). Go switches the edge-runtime image
  // to the `deno1` tag when this is 1 (`apps/cli-go/pkg/config/config.go:999-1008`);
  // the declarative pg-delta runner needs it to pick the matching image.
  const denoVersionRaw = edgeRuntimeRaw?.["deno_version"];
  const denoVersionNum =
    typeof denoVersionRaw === "number"
      ? denoVersionRaw
      : typeof denoVersionRaw === "string"
        ? Number.parseInt(legacyExpandEnv(denoVersionRaw, lookup), 10)
        : Number.NaN;
  // Go's config.Validate rejects a present-but-invalid deno_version before pg-delta
  // runs (`config.go:999-1008`): 0 → missing-required, anything other than 1/2 →
  // invalid. An absent key falls through to the default (Go merges deno_version=2).
  if (denoVersionRaw !== undefined && Number.isInteger(denoVersionNum)) {
    if (denoVersionNum === 0) {
      return yield* Effect.fail(
        new LegacyDbConfigLoadError({
          message: "Missing required field in config: edge_runtime.deno_version",
        }),
      );
    }
    if (denoVersionNum !== 1 && denoVersionNum !== 2) {
      return yield* Effect.fail(
        new LegacyDbConfigLoadError({
          message: `Failed reading config: Invalid edge_runtime.deno_version: ${denoVersionNum}.`,
        }),
      );
    }
  }
  const denoVersion = Number.isInteger(denoVersionNum) ? denoVersionNum : DEFAULT_DENO_VERSION;

  // `[experimental.pgdelta]`. `enabled` is a TOML bool (Go decodes weakly, so an
  // `env(VAR)`/string "true" also counts); `declarative_schema_path` is resolved
  // to a `supabase/`-prefixed path when relative (Go's `config.resolve`).
  const enabledRaw = pgDeltaRaw?.["enabled"];
  const enabled =
    typeof enabledRaw === "boolean"
      ? enabledRaw
      : typeof enabledRaw === "string"
        ? legacyExpandEnv(enabledRaw, lookup) === "true"
        : false;

  const declarativeSchemaPathRaw = pgDeltaRaw?.["declarative_schema_path"];
  let declarativeSchemaPath = Option.none<string>();
  if (typeof declarativeSchemaPathRaw === "string") {
    const expanded = legacyExpandEnv(declarativeSchemaPathRaw, lookup);
    if (expanded.length > 0) {
      declarativeSchemaPath = Option.some(
        path.isAbsolute(expanded) ? expanded : path.join("supabase", expanded),
      );
    }
  }

  const formatOptionsRaw = pgDeltaRaw?.["format_options"];
  const formatOptionsExpanded =
    typeof formatOptionsRaw === "string" ? legacyExpandEnv(formatOptionsRaw, lookup) : "";
  // Go's config.Validate aborts config load when a non-empty format_options is not
  // valid JSON (`apps/cli-go/pkg/config/config.go:1685-1686`), before any shadow /
  // catalog container runs. Fail here with Go's exact message so the user gets the
  // actionable error up front rather than a later `JSON.parse` failure in the script.
  if (formatOptionsExpanded.length > 0 && !legacyIsValidJson(formatOptionsExpanded)) {
    return yield* Effect.fail(
      new LegacyDbConfigLoadError({
        message: "Invalid config for experimental.pgdelta.format_options: must be valid JSON",
      }),
    );
  }
  const formatOptions = nonEmptyString(formatOptionsExpanded);

  // `[db.vault]` secret names, sorted (Go's `setupInputsToken` sorts before hashing).
  const vaultRaw = asRecord(db?.["vault"]);
  const vaultNames = vaultRaw === undefined ? [] : Object.keys(vaultRaw).sort();

  // `[api] auto_expose_new_tables` is a tri-state `*bool`: present → Some(bool).
  const autoExposeRaw = apiRaw?.["auto_expose_new_tables"];
  const apiAutoExposeNewTables =
    typeof autoExposeRaw === "boolean"
      ? Option.some(autoExposeRaw)
      : typeof autoExposeRaw === "string"
        ? Option.some(legacyExpandEnv(autoExposeRaw, lookup) === "true")
        : Option.none<boolean>();

  const values: LegacyDbTomlValues = {
    port,
    shadowPort,
    password: passwordRaw !== undefined ? legacyExpandEnv(passwordRaw, lookup) : DEFAULT_PASSWORD,
    poolerConnectionString,
    projectId,
    majorVersion,
    denoVersion,
    pgDelta: {
      enabled,
      declarativeSchemaPath,
      formatOptions,
      npmVersion: pgDeltaNpmVersion,
    },
    baseline: {
      authEnabled: resolveBool(authRaw?.["enabled"], true, lookup),
      storageEnabled: resolveBool(storageRaw?.["enabled"], true, lookup),
      realtimeEnabled: resolveBool(realtimeRaw?.["enabled"], true, lookup),
      apiAutoExposeNewTables,
      vaultNames,
    },
  };
  return values;
});

/**
 * The effective declarative schema directory: the configured
 * `declarative_schema_path` (already `supabase/`-prefixed when relative) or the
 * default `supabase/database`. Mirrors Go's `utils.GetDeclarativeDir`
 * (`apps/cli-go/internal/utils/misc.go:119-124`). `path` joins the segments so
 * the separator matches the host platform, as Go's `filepath.Join` does.
 */
export function legacyResolveDeclarativeDir(
  path: Path.Path,
  pgDelta: LegacyPgDeltaTomlConfig,
): string {
  return Option.getOrElse(pgDelta.declarativeSchemaPath, () =>
    path.join(...DEFAULT_DECLARATIVE_DIR_SEGMENTS),
  );
}
