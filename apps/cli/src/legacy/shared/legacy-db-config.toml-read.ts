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
 * Mirrors Go's `flags.LoadConfig` → `config.Load`
 * (`apps/cli-go/internal/utils/flags/config_path.go:10`,
 * `pkg/config/config.go`): a **missing** config file yields `config.NewConfig()`
 * defaults, but a **malformed** file is a hard error (Go returns the decode error
 * and aborts the command rather than running against the default local database).
 */
interface LegacyDbTomlValues {
  /**
   * Resolves a `SUPABASE_*` env var with Go's precedence: shell env (non-empty)
   * wins, then the loaded project `.env*` files (non-empty), else undefined.
   * Go writes project `.env` into the process env before viper's `AutomaticEnv`
   * reads these (`config.go:624,1055-1096`), so handlers must consult both
   * rather than `process.env` alone (e.g. `SUPABASE_EXPERIMENTAL_PG_DELTA`).
   */
  readonly envLookup: (name: string) => string | undefined;
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
   * `[experimental] orioledb_version` (env-expanded). When set on a 15/17 project,
   * Go's `config.Validate` rewrites the Postgres image to the OrioleDB tag
   * (`apps/cli-go/pkg/config/config.go:876-894`); `None` for a vanilla project.
   */
  readonly orioledbVersion: Option.Option<string>;
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
  /** `[db.migrations] enabled` (default true) — gates `up`/`down` migration apply. */
  readonly migrationsEnabled: boolean;
  /** `[db.seed]` enabled + supabase-prefixed `sql_paths` globs — used by `down`. */
  readonly seed: LegacyDbSeedTomlConfig;
  /** `[db.vault]` secrets (name → resolved value) — upserted by `up`/`down`. */
  readonly vault: ReadonlyArray<LegacyDbVaultSecretToml>;
  /**
   * The matched `[remotes.<name>]` block name when a linked ref merged its override
   * (Go's `Loading config override: [remotes.<name>]` line), else `undefined`.
   */
  readonly appliedRemote: string | undefined;
}

/** `[db.seed]` config surfaced for `migration down`'s seed step. */
interface LegacyDbSeedTomlConfig {
  readonly enabled: boolean;
  /** Glob patterns, each supabase-prefixed when relative (Go's `config.resolve`). */
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
/** `[edge_runtime] deno_version` default (`config.toml` template). 2 → the current edge-runtime image. */
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
interface LegacyRemoteOverride {
  readonly doc: RawDoc | undefined;
  /**
   * The name of the matched `[remotes.<name>]` block whose `project_id` equals the
   * resolved ref, or `undefined` when no block matched. Callers echo Go's
   * `Loading config override: [remotes.<name>]` stderr line from this.
   */
  readonly appliedRemote?: string;
  /**
   * The config keys the matched remote block contributed at viper's OVERRIDE tier. Go's
   * `mergeRemoteConfig` applies every block key via `v.Set(...)` after `AutomaticEnv`
   * (`config.go:635-640`), and `v.Set` sits ABOVE `AutomaticEnv` (`viper.go:1167-1174` vs
   * `:1226-1237`), so each explicitly-set remote key — plus the forced `db.seed.enabled`
   * default Go injects when the block omits it — must outrank the matching `SUPABASE_*`
   * env override (a plain TOML value elsewhere is still env-overridable). Holds every key in
   * `LEGACY_ENV_OVERRIDABLE_KEYS` the matched block supplies, plus `db.seed.enabled` (always).
   */
  readonly remoteOverrideKeys: ReadonlySet<string>;
}

/**
 * The `project_id` of a `[remotes.<name>]` block as Go's in-load matching/dedup loop sees
 * it: `v.GetString("remotes.<name>.project_id")` (`config.go:510`). Viper's `AutomaticEnv`
 * binds that key to `SUPABASE_REMOTES_<NAME>_PROJECT_ID` (`SetEnvPrefix("SUPABASE")` +
 * `EnvKeyReplacer(".","_")`, `config.go:494-498`), so a non-empty env value wins OUTRIGHT;
 * an empty env value is dropped (`AllowEmptyEnv=false`; godotenv never overrides an empty
 * shell var), falling back to the RAW TOML literal. `GetString` does NOT run mapstructure's
 * `LoadEnvHook`, so a TOML `env(...)` form is NOT expanded for block selection or duplicate
 * detection — that hook only fires during `UnmarshalExact` (`config.go:661-666`), after this
 * loop. Validation reads the decoded (expanded) field instead — see
 * `legacyResolveValidatedRemoteProjectId`.
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
 * The `project_id` of a `[remotes.<name>]` block as Go's `config.Validate` sees it: the
 * DECODED struct field `remote.ProjectId` (`config.go:909-913`), which has already passed
 * through `LoadEnvHook` — so a TOML `env(...)` literal IS expanded here (an unset `env(...)`
 * stays literal and fails the ref pattern). The `SUPABASE_REMOTES_<NAME>_PROJECT_ID` env
 * override still wins when non-empty, matching viper precedence in both `GetString` and
 * `UnmarshalExact`.
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
 * Every dotted config key this reader resolves with a `SUPABASE_*` AutomaticEnv override.
 * When a matched `[remotes.*]` block supplies any of these, Go's `mergeRemoteConfig` flattens
 * the whole block via `u.AllKeys()` and applies each leaf with `v.Set` (override tier, above
 * `AutomaticEnv` — `config.go:635-637`), so the block value must beat the env override.
 */
const LEGACY_ENV_OVERRIDABLE_KEYS: ReadonlyArray<string> = [
  "db.port",
  "db.shadow_port",
  "db.major_version",
  "db.migrations.enabled",
  "db.seed.enabled",
  "db.seed.sql_paths",
  "auth.enabled",
  "edge_runtime.deno_version",
  "experimental.pgdelta.enabled",
  "experimental.pgdelta.declarative_schema_path",
  "experimental.pgdelta.format_options",
  "api.auto_expose_new_tables",
  "analytics.enabled",
  "analytics.backend",
  "analytics.gcp_project_id",
  "analytics.gcp_project_number",
  "analytics.gcp_jwt_path",
];

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
    // Match on the project_id Go's `v.GetString` returns (env override > RAW TOML literal,
    // no `env(...)` expansion — `config.go:510`), so a block whose id comes from
    // `SUPABASE_REMOTES_<NAME>_PROJECT_ID` still merges while a TOML `env(...)` literal does
    // not (Go selects blocks before the decode hook expands it).
    if (legacyResolveRemoteProjectId(name, block, lookup) === ref) {
      const merged = deepMergeDoc(doc, block);
      const blockSeed = asRecord(asRecord(block["db"])?.["seed"]);
      // Go's `mergeRemoteConfig` flattens the WHOLE matched block via `u.AllKeys()` and applies
      // every leaf with `v.Set` (override tier, above `AutomaticEnv` — `config.go:635-637`).
      // Record every env-overridable key the block supplies — not just migrations/seed — so the
      // resolution below suppresses their `SUPABASE_*` value.
      const remoteOverrideKeys = new Set<string>();
      for (const key of LEGACY_ENV_OVERRIDABLE_KEYS) {
        if (legacyBlockProvidesKey(block, key)) remoteOverrideKeys.add(key);
      }
      // `db.seed.enabled` is ALWAYS override-tier for a matched block: either the block set
      // it, or Go's `mergeRemoteConfig` forces it `false` when omitted (`config.go:638-640`)
      // — so env never overrides it on a matched-remote linked run.
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
 * Go's `config.Load` aborts when two `[remotes.*]` blocks declare the same
 * `project_id` (`pkg/config/config.go:506-511`), regardless of which command runs.
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
    // Dedupe on the project_id Go's `v.GetString` returns (env override > RAW TOML literal,
    // no `env(...)` expansion), matching Go's duplicate check (`config.go:506-511`).
    const projectId = legacyResolveRemoteProjectId(name, block, lookup);
    if (projectId === undefined) continue;
    const prior = seen.get(projectId);
    if (prior !== undefined) return { name, other: prior };
    seen.set(projectId, name);
  }
  return undefined;
}

/**
 * Go's `config.Validate` rejects any `[remotes.<name>]` whose `project_id` is not a
 * valid project ref (`config.go:832-836`), on every config load — so a malformed or
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
    // Go's `Validate` over the decoded `remote.ProjectId` field (`config.go:909-913`), which
    // passed through `LoadEnvHook`. An unset `env(...)` stays literal and still fails Go's
    // ref pattern. (Block matching/dedup above use the RAW literal — Go's `v.GetString`.)
    const projectId = legacyResolveValidatedRemoteProjectId(name, block, lookup);
    if (typeof projectId !== "string" || !LEGACY_PROJECT_REF_PATTERN.test(projectId)) {
      return name;
    }
  }
  return undefined;
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

/**
 * Resolve an optional integer config field (e.g. `db.major_version`) the way Go's
 * config load does: a quoted `env(VAR)` reference is expanded by `LoadEnvHook` and
 * the result is then decoded into a `uint`, which strictly rejects a non-integer
 * string like `17foo` rather than truncating it (Go sets no `WeaklyTypedInput`).
 * Returns the parsed integer, `"absent"` when the field is omitted (caller uses the
 * default), or `"invalid"` when present but not a whole non-negative integer (caller
 * fails the load rather than silently defaulting and hiding a broken config).
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

/**
 * Replicates Go's `path.Join("supabase", pattern)` for a relative seed `sql_paths`
 * entry (`pkg/config/config.go:881-886`). Go's `path.Join` runs `path.Clean`, which
 * collapses `.`/`..` segments (`../seed.sql` → `seed.sql`, `sub/../seed.sql` →
 * `supabase/seed.sql`, `../../x.sql` → `../x.sql`). The cleaned path is the
 * `seed_files` hash key, so a non-collapsed key would miss Go's record and re-run/
 * re-record the seed on a cross-CLI switch. Forward-slash only (Go uses `path.Join`,
 * not the platform `filepath.Join`).
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
 * Resolves a single seed `sql_paths` entry to Go's config-load form: a relative
 * pattern is joined under `supabase/` (Go's `path.Join`, `config.go:918-921`); an
 * absolute (or empty) pattern is returned verbatim. Used by the reader for
 * `[db.seed].sql_paths` and by `db reset` for its `--sql-paths` override (Go's
 * `resolveSeedSqlPaths`, `cmd/db.go`) so both feed the glob the same resolved paths.
 */
export const legacyResolveSeedSqlPath = (pathSvc: Path.Path, pattern: string): string =>
  pattern.length === 0 || pathSvc.isAbsolute(pattern)
    ? pattern
    : legacyJoinSupabaseSeedPath(pattern);

/** `[db]` ports default through the development env unless `SUPABASE_ENV` overrides. */
const DEFAULT_SUPABASE_ENV = "development";

/**
 * Keys {@link legacyApplyProjectEnv} copies from the project `.env` into
 * `process.env`. Kept to an allowlist of values that are read *only* via
 * `process.env` (no project-env map path) and must reflect `supabase/.env` —
 * currently just `SUPABASE_INTERNAL_IMAGE_REGISTRY` (`legacyGetRegistryImageUrl`).
 * Everything else is read from {@link legacyLoadProjectEnv}'s returned map
 * (`envLookup`, `legacyResolveYesWithProjectEnv`, `resolveDbPassword`) or resolved
 * eagerly from the shell before any `.env` load — Go's root globals (workdir /
 * profile / `SUPABASE_ENV` / project-ref) are frozen before `loadNestedEnv`, so
 * writing them here would let our lazily-built resolvers diverge from Go (retarget
 * the project, switch the env-file set, or leak into the Go `--experimental` proxy).
 */
const LEGACY_PROCESS_ENV_APPLY_KEYS = ["SUPABASE_INTERNAL_IMAGE_REGISTRY"] as const;

/**
 * Load the project's nested `.env` files into a lookup map. **Pure**: it reads the
 * files and returns the merged map, with no `process.env` side effect — so the
 * `SUPABASE_YES` / `SUPABASE_DB_PASSWORD` readers that call it
 * (`legacyResolveYesWithProjectEnv`, `resolveDbPassword`) never mutate the global
 * environment. Commands that need an allowlisted key visible to a synchronous
 * `process.env` reader (`db dump` / `db pull` → `legacyGetRegistryImageUrl`) opt
 * into {@link legacyApplyProjectEnv} around the container work instead.
 *
 * Partially mirrors Go's `loadNestedEnv` + `loadDefaultEnv`
 * (`pkg/config/config.go:1047-1085`). Go walks from the `supabase/` directory up to
 * the repo root and, in each directory, loads `.env.<env>.local`, `.env.local`
 * (skipped when `SUPABASE_ENV=test`), `.env.<env>`, then `.env` via `godotenv.Load`,
 * which never overrides a value already set. So the shell environment wins over the
 * files, the `supabase/` directory wins over the repo root, and earlier filenames
 * win within a directory. A malformed `.env` — or one that exists but cannot be
 * read — aborts: Go's `loadEnvIfExists` swallows only `os.ErrNotExist` and returns
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
 * the opt-in counterpart to the pure {@link legacyLoadProjectEnv}: `db dump` /
 * `db pull` run it around their pg_dump / diff container work so a
 * `SUPABASE_INTERNAL_IMAGE_REGISTRY` set in `supabase/.env` reaches
 * `legacyGetRegistryImageUrl` (which reads `process.env` synchronously) — mirroring
 * the `os.Setenv` half of Go's `loadNestedEnv`. Kept out of the shared loader so
 * SUPABASE_YES / db-password reads stay side-effect-free.
 *
 * Never overrides an existing `process.env` value (Go's `godotenv.Load` never
 * overrides; `loaded` already excludes keys present in `process.env`, and this
 * re-checks). The `acquireRelease` finalizer deletes only the keys it set when the
 * scope closes, so in-process test workers don't leak env between cases.
 */
export const legacyApplyProjectEnv = (loaded: Record<string, string>) =>
  Effect.forEach(
    LEGACY_PROCESS_ENV_APPLY_KEYS,
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
  // Go decodes a numeric config value into a bool via mapstructure's weakly-typed input:
  // `value != 0` (mapstructure `decodeBool`; `getKind` collapses every int/uint/float
  // width). A TOML number (`enabled = 0`) is therefore an explicit false, NOT absent — it
  // must not fall through to the schema default.
  if (typeof value === "number") return value !== 0;
  // Absent → the schema default. A PRESENT non-scalar (array/inline table, e.g.
  // `enabled = []`) is a decode error in Go's `UnmarshalExact` during `LoadConfig`, so it
  // must NOT fall through to the default — otherwise `db reset` could accept the prompt and
  // drop schemas on a config Go rejects up front.
  if (value === undefined) return fallback;
  return "invalid";
}

/**
 * `resolveBool` that fails the config load on a malformed bool (Go's parse error).
 * `envValue` is the `SUPABASE_*` AutomaticEnv override (`pkg/config/config.go:494-498`):
 * when set it wins over the TOML value/default, matching viper's env > config-file
 * precedence (`envOverride` already drops empty values, like `AllowEmptyEnv=false`).
 * The override is still a string-kind value decoded through `LoadEnvHook`, so an
 * `env(VAR)` indirection (`SUPABASE_DB_SEED_ENABLED=env(SEED_ON)`) is expanded before
 * the bool parse (`decode_hooks.go:15-26` runs ahead of the weak `ParseBool` decode).
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
 * Tri-state (`*bool`) sibling of `resolveBoolOrFail` for fields Go decodes as a
 * pointer-bool (absent → `nil`/`None`, never `false`). The `SUPABASE_*` AutomaticEnv
 * override wins when present; otherwise a present TOML bool/string is decoded with Go's
 * `strconv.ParseBool` set (`legacyParseGoBool`) and a malformed value aborts the load
 * with Go's `failed to parse config` error (`pkg/config/config.go:584-590`). An absent
 * value stays `None`. (`envOverride` already drops empty env values, matching viper's
 * `AllowEmptyEnv=false`.)
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
  // Absent → `None` (Go's `*bool` stays nil). A present non-scalar value fails Go's
  // `UnmarshalExact`, so reject it here rather than silently treating it as absent.
  if (value === undefined) return Option.none<boolean>();
  return yield* Effect.fail(
    new LegacyDbConfigLoadError({ message: `failed to parse config: invalid ${field}.` }),
  );
});

/**
 * Dotted paths of every `config.Secret`-typed field Go decrypts via its global
 * `DecryptSecretHookFunc` (`pkg/config/secret.go`, `config.go:730`) — the hook only runs
 * while decoding INTO a `config.Secret`, never over arbitrary strings. `*` matches any map
 * key (`auth.external.<provider>`, `auth.hook.<name>`). `[db.vault]` (a `map[string]Secret`)
 * is intentionally omitted — the reader decrypts it directly in the body with the same
 * fail-on-undecryptable behaviour. Derived from the Go structs (`auth.go`, `db.go`,
 * `config.go`); update alongside any new `Secret` field.
 */
const LEGACY_SECRET_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  ["db", "root_key"],
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
  // Go decodes `[edge_runtime.secrets]` as `SecretsConfig map[string]Secret` (config.go:283,287),
  // so every value is decrypted by the hook — `*` spans the arbitrary secret names.
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

/** Fails when a single `encrypted:` secret value cannot be decrypted (Go's hook error). */
const legacyAssertSecretValue = (
  value: string,
  lookup: EnvLookup,
  dotenvPrivateKeys: ReadonlyArray<string>,
): LegacyDbConfigLoadError | undefined => {
  const expanded = legacyExpandEnv(value, lookup);
  // Unset `env(...)` and plain strings are returned verbatim by Go's hook (no error).
  if (ENV_PATTERN.test(expanded) || !legacyIsEncryptedSecret(expanded)) return undefined;
  const decrypted = legacyDecryptSecret(expanded, dotenvPrivateKeys);
  return decrypted.ok
    ? undefined
    : new LegacyDbConfigLoadError({ message: `failed to parse config: ${decrypted.error}` });
};

/**
 * Asserts every `config.Secret`-typed `encrypted:` value in the (merged) config can be
 * decrypted, mirroring Go's global `DecryptSecretHookFunc`, which aborts the load with
 * `failed to parse config: <error>` when a secret cannot be decrypted. Only the actual
 * `Secret` field paths ({@link LEGACY_SECRET_PATHS}) are scanned — a non-secret string that
 * merely starts with `encrypted:` (e.g. an auth email-template `subject`) stays plain text
 * in Go and must not block the load. Go decodes every `[remotes.<name>]` block into the same
 * struct, so the same paths are checked under each remote too. Returns the failure (or
 * `undefined`); the caller surfaces it via `Effect.fail`.
 */
const legacyAssertDecryptableSecrets = (
  doc: unknown,
  lookup: EnvLookup,
  dotenvPrivateKeys: ReadonlyArray<string>,
): LegacyDbConfigLoadError | undefined => {
  const scan = (node: unknown): LegacyDbConfigLoadError | undefined => {
    for (const segs of LEGACY_SECRET_PATHS) {
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
// `auth.site_url` is non-empty; only an explicit empty string fails A1 (`config.go:1037`).
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
  // `project_id` equals `ref` is merged over the base config before fields are
  // read — Go's `config.Load` merge keyed on `Config.ProjectId` (config.go:503-562).
  // `--local` / `--db-url` / declarative pass nothing and read the unmerged config,
  // matching Go (those paths never resolve a ref before config load).
  ref?: string,
  // Internal: when true the on-disk `config.toml` is treated as absent so the body
  // resolves pure defaults (still honoring `SUPABASE_*` env overrides, which Go binds
  // regardless of a config file). The lenient `legacyReadDbToml({ validate: false })`
  // wrapper uses this as its fallback after a config-load failure, mirroring the
  // best-effort behavior the container-id seam relied on before.
  ignoreConfigFile = false,
) {
  const supabaseDir = path.join(workdir, "supabase");
  const configPath = path.join(supabaseDir, "config.toml");

  // Distinguish "absent" (→ defaults) from "present but unreadable/malformed" (→ fail),
  // matching Go's `mergeFileConfig` (`pkg/config/config.go:528`): only `os.ErrNotExist`
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

  // Resolve `env(VAR)` against the shell env first, then the project `.env` files
  // (Go's `loadNestedEnv` populates the process env before `LoadEnvHook`). Built
  // here — before the remote-config validation/merge below — so remote and
  // top-level `project_id` env() forms are expanded before they are validated or
  // used to derive Docker IDs, matching Go's decode-then-validate ordering.
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, workdir);
  const lookup: EnvLookup = (name) => process.env[name] ?? projectEnv[name];
  // dotenvx private keys for decrypting `encrypted:` secrets (Go's DecryptSecretHookFunc),
  // from the shell + project env. Used by the global secret-decryptability assertion below
  // and the `[db.vault]` resolution.
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
  // (`project_id = ""`). Go keeps that empty override and `config.Validate` fails with
  // `Missing required field in config: project_id` (config.go:991); tracked here so the
  // check can run after the `SUPABASE_PROJECT_ID` env override below may still rescue it.
  let projectIdExplicitEmpty = false;
  // Config keys a matched remote block contributed at viper's override tier (Go's
  // `v.Set`), so they must beat the matching `SUPABASE_*` env overrides below.
  let remoteOverrideKeys: ReadonlySet<string> = new Set();
  // The matched `[remotes.<name>]` block name, echoed as Go's config-override line.
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
    // Go aborts config load when two `[remotes.*]` blocks share a `project_id`,
    // regardless of which command runs (config.go:506-511) — check before merging.
    const duplicateRemote = findDuplicateRemoteProjectId(doc, lookup);
    if (duplicateRemote !== undefined) {
      return yield* Effect.fail(
        new LegacyDbConfigLoadError({
          message: `duplicate project_id for [remotes.${duplicateRemote.name}] and [remotes.${duplicateRemote.other}]`,
        }),
      );
    }
    // Go's Validate rejects any remote whose `project_id` is not a valid 20-char ref,
    // on every load (config.go:832-836), after the duplicate check. So a malformed
    // remote fails even local/direct commands before any DB connection.
    const invalidRemote = findInvalidRemoteProjectId(doc, lookup);
    if (invalidRemote !== undefined) {
      return yield* Effect.fail(
        new LegacyDbConfigLoadError({
          message: `Invalid config for remotes.${invalidRemote}.project_id. Must be like: abcdefghijklmnopqrst`,
        }),
      );
    }
    // Apply a matching `[remotes.<name>]` override (Go merges the block whose
    // `project_id` equals the resolved ref over the base, config.go:503-562).
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
    // Go expands `env(VAR)` for the top-level `project_id` during `config.Load`
    // (`config.go:584-588`) before `UpdateDockerIds` derives container names from
    // it, so expand here too — otherwise a `project_id = "env(PROJECT_ID)"` would
    // sanitize to a wrong local-stack id like `supabase_db_env_PROJECT_ID_`.
    const rawProjectId = effectiveDoc?.["project_id"];
    projectId = nonEmptyString(
      typeof rawProjectId === "string" ? legacyExpandEnv(rawProjectId, lookup) : rawProjectId,
    );
    // A present `project_id` string that resolves to empty is Go's "kept empty override".
    projectIdExplicitEmpty = typeof rawProjectId === "string" && Option.isNone(projectId);

    // Go's `DecryptSecretHookFunc` is a global decode hook (config.go:730) that decrypts
    // EVERY `config.Secret` field during `UnmarshalExact`, so an `encrypted:` secret anywhere
    // in the merged config that cannot be decrypted (e.g. no DOTENV_PRIVATE_KEY) aborts the
    // load with `failed to parse config: <error>` (secret.go:34,103; config.go:704) — before
    // Validate and before connecting. The reader otherwise only decrypts `[db.vault]`, so
    // assert decryptability across the whole document to match Go (a recursive scan tracks
    // Go's "decode the entire config" better than a hand-listed set of Secret paths).
    const secretError = legacyAssertDecryptableSecrets(effectiveDoc, lookup, dotenvPrivateKeys);
    if (secretError !== undefined) return yield* Effect.fail(secretError);
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

  // Go's viper AutomaticEnv binds the top-level `project_id` to `SUPABASE_PROJECT_ID`
  // (`config.go:529-535`), so the env value overrides the TOML `project_id` before
  // `UpdateDockerIds` derives the local-stack container/network names from it
  // (`internal/utils/config.go:57-63` — `NetId = supabase_network_<project_id>`). The
  // reader's `projectId` is exactly that Docker-naming id, so apply the override here
  // (env-expanded like the TOML value, then sanitized at the consumer) — otherwise
  // `test db --local` joins `supabase_network_<toml-or-basename>` while Go honors the
  // env id. This is independent of the linked-ref resolver, which reads the env var on
  // its own chain; the env value is bound regardless of whether a config file exists.
  const projectIdEnv = envOverride("SUPABASE_PROJECT_ID");
  if (projectIdEnv !== undefined) {
    projectId = nonEmptyString(legacyExpandEnv(projectIdEnv, lookup));
  }

  // Go's `config.Validate` rejects an empty top-level `project_id` (config.go:991). An
  // absent field is tolerated here (deferred), but a present `project_id = ""` that the
  // `SUPABASE_PROJECT_ID` override did not rescue is a load error, so a destructive command
  // (e.g. remote `db reset`) fails fast rather than dropping schemas on a config Go rejects.
  if (projectIdExplicitEmpty && Option.isNone(projectId)) {
    return yield* Effect.fail(
      new LegacyDbConfigLoadError({ message: "Missing required field in config: project_id" }),
    );
  }

  // A present-but-unmarshalable port aborts in Go rather than defaulting; mirror
  // that so `test db --local` never silently targets the default local database
  // while hiding a broken `[db]` config.
  const port = resolvePort(
    (remoteOverrideKeys.has("db.port") ? undefined : envOverride("SUPABASE_DB_PORT")) ??
      db?.["port"],
    DEFAULT_PORT,
    lookup,
  );
  const shadowPort = resolvePort(
    (remoteOverrideKeys.has("db.shadow_port")
      ? undefined
      : envOverride("SUPABASE_DB_SHADOW_PORT")) ?? db?.["shadow_port"],
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
  // Go's `config.Validate` rejects an explicit `db.port = 0` (`config.go:980-981`); an
  // absent port is defaulted before Validate, so only a present 0 fails. `resolvePort`
  // accepts 0 as a syntactically valid uint16, so the zero check lives here. No equivalent
  // for `shadow_port` — Go has no `ShadowPort == 0` validation (`pkg/config/db.go:85`).
  if (port === 0) {
    return yield* Effect.fail(
      new LegacyDbConfigLoadError({ message: "Missing required field in config: db.port" }),
    );
  }

  // Go's `db.Password` is tagged `json:"-"` (`apps/cli-go/pkg/config/db.go:88`), so
  // it is NOT bound from `SUPABASE_DB_PASSWORD` — the local password is the fixed
  // config value/`"postgres"` default. `DB_PASSWORD` is read only by linked password
  // resolution (`legacy-db-config.layer.ts`), so the local password must not source
  // it or `db query --local` etc. would authenticate with a remote secret.
  const passwordRaw = typeof db?.["password"] === "string" ? db["password"] : undefined;

  // Go expands a quoted `env(VAR)` reference for `major_version` and then decodes
  // it into a `uint`, strictly rejecting a non-integer string (`17foo` is NOT
  // truncated to 17) and resolving `env(PG_MAJOR)` before validation
  // (`apps/cli-go/pkg/config/config.go` viper + mapstructure). `resolveConfigInt`
  // mirrors that; `SUPABASE_DB_MAJOR_VERSION` overrides the TOML via AutomaticEnv.
  const majorVersionRaw =
    (remoteOverrideKeys.has("db.major_version")
      ? undefined
      : envOverride("SUPABASE_DB_MAJOR_VERSION")) ?? db?.["major_version"];
  const majorVersionResolved = resolveConfigInt(majorVersionRaw, lookup);
  if (majorVersionResolved === "invalid") {
    // Present but not a whole integer (`17foo`, or an `env(VAR)` that does not
    // resolve to digits): Go fails the config parse rather than defaulting.
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
  // Rejecting an unsupported major version ({13,14,15,17}; `apps/cli-go/pkg/config/config.go:
  // 869-897`) is now `legacyValidateResolvedConfig`'s `db.major_version` switch (called once,
  // below) — an absent value falls through to the default (Go's zero-then-default) and a present
  // one (including `0`) flows into `input.db.majorVersion` for that switch to check.
  const majorVersion =
    typeof majorVersionResolved === "number" ? majorVersionResolved : DEFAULT_MAJOR_VERSION;

  // `[experimental] orioledb_version`: on a 15/17 project Go's Validate rewrites the
  // Postgres image to the OrioleDB tag and `assertEnvLoaded`s the four S3 fields
  // (`apps/cli-go/pkg/config/config.go:874-894`). Expand env() like every other
  // field; the image rewrite itself is applied by `legacyResolveDbImage`.
  const expandString = (value: unknown): Option.Option<string> =>
    typeof value === "string" ? nonEmptyString(legacyExpandEnv(value, lookup)) : Option.none();
  const orioledbVersion = expandString(experimentalRaw?.["orioledb_version"]);
  if (Option.isSome(orioledbVersion) && (majorVersion === 15 || majorVersion === 17)) {
    // `assertEnvLoaded` warns (does NOT fail) for any S3 value still holding an
    // unexpanded `env(VAR)` after env loading (`config.go:1029-1034`). Match the
    // stderr line byte-for-byte; the env var name is the `env(...)` capture.
    const s3Fields = ["s3_host", "s3_region", "s3_access_key", "s3_secret_key"] as const;
    for (const field of s3Fields) {
      const raw = experimentalRaw?.[field];
      if (typeof raw !== "string") continue;
      const expanded = legacyExpandEnv(raw, lookup);
      const unset = ENV_PATTERN.exec(expanded);
      if (unset !== null) {
        process.stderr.write(`WARN: environment variable is unset: ${unset[1] ?? ""}\n`);
      }
    }
  }

  // `[edge_runtime] deno_version` (default 2). Go switches the edge-runtime image
  // to the `deno1` tag when this is 1 (`apps/cli-go/pkg/config/config.go:999-1008`);
  // the declarative pg-delta runner needs it to pick the matching image. Go's viper
  // `AutomaticEnv` lets `SUPABASE_EDGE_RUNTIME_DENO_VERSION` override the TOML before
  // validation (same generic prefix+replacer binding as the pg-delta env vars below),
  // so a CI env override decides which edge-runtime image pg-delta runs under.
  const denoVersionRaw =
    (remoteOverrideKeys.has("edge_runtime.deno_version")
      ? undefined
      : envOverride("SUPABASE_EDGE_RUNTIME_DENO_VERSION")) ?? edgeRuntimeRaw?.["deno_version"];
  // Go decodes `deno_version` into a `uint` before validation, so a present non-integer
  // string (`2foo`) or an unresolved `env(MISSING)` aborts the load rather than falling
  // through to the default Deno 2 image. `resolveConfigInt` expands `env()` then requires
  // a whole integer; the validation switch (`config.go:999-1008`) handles the rest.
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
  // Rejecting a present-but-invalid deno_version (`config.go:999-1008`: 0 → missing-required,
  // anything other than 1/2 → invalid) is now `legacyValidateResolvedConfig`'s
  // `edgeRuntimeDenoVersion` switch (called once, below). An absent key falls through to the
  // default (Go merges deno_version=2).
  const denoVersion =
    typeof denoVersionResolved === "number" ? denoVersionResolved : DEFAULT_DENO_VERSION;

  // `[experimental.pgdelta]`. `enabled` is a TOML bool (Go decodes weakly, so an
  // `env(VAR)`/string "true" also counts); `declarative_schema_path` is resolved
  // to a `supabase/`-prefixed path when relative (Go's `config.resolve`).
  // Go's viper `AutomaticEnv` lets `SUPABASE_EXPERIMENTAL_PGDELTA_*` override the
  // TOML before validation (`config.go` `SetEnvPrefix("SUPABASE")` + `.`→`_`), so a
  // CI env override decides the gate / paths. `envOverride` is the shell→project-.env
  // lookup that ignores empty values, matching viper.
  const enabledRaw = pgDeltaRaw?.["enabled"];
  const enabledEnv = remoteOverrideKeys.has("experimental.pgdelta.enabled")
    ? undefined
    : envOverride("SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED");
  // Go decodes this bool via `strconv.ParseBool` (mapstructure weakly typed), so `"1"`
  // counts as true and a malformed value (`SUPABASE_EXPERIMENTAL_PGDELTA_ENABLED=maybe`)
  // aborts the load. The env override wins (viper AutomaticEnv), then the TOML bool, then
  // an `env(VAR)` string, defaulting to false when absent.
  let enabled: boolean;
  if (enabledEnv !== undefined) {
    // The AutomaticEnv override is decoded through `LoadEnvHook`, so an `env(VAR)`
    // indirection is expanded before the weak `ParseBool` decode (`decode_hooks.go:15-26`).
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
  // The AutomaticEnv override and the TOML literal both flow through Go's `LoadEnvHook`
  // (`decode_hooks.go:15-26`) under `UnmarshalExact`, so an `env(VAR)` indirection is expanded
  // before the path is used — whichever source wins. Expand once over the resolved value
  // (`legacyExpandEnv` is a no-op on a non-`env()` string).
  const declarativeSchemaPathValue = legacyExpandEnv(
    (remoteOverrideKeys.has("experimental.pgdelta.declarative_schema_path")
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
    (remoteOverrideKeys.has("experimental.pgdelta.format_options")
      ? undefined
      : envOverride("SUPABASE_EXPERIMENTAL_PGDELTA_FORMAT_OPTIONS")) ??
      (typeof formatOptionsRaw === "string" ? formatOptionsRaw : ""),
    lookup,
  );
  // Rejecting a non-empty, non-JSON `format_options` (`apps/cli-go/pkg/config/config.go:
  // 1685-1686`) is now `legacyValidateResolvedConfig`'s `experimental.pgdeltaFormatOptions`
  // check (called once, below).
  const formatOptions = nonEmptyString(formatOptionsExpanded);

  // Bucket-name/function-slug validation (`config.go:898-903`/`993-998`) now lives in
  // `legacyValidateResolvedConfig` (called once, below); only the pure extraction stays here.
  const bucketsRaw = asRecord(storageRaw?.["buckets"]);

  // Go's config.Validate runs the full `if c.Auth.Enabled` block (`config.go:1036-1102`) after
  // the bucket/function checks. Gated on `auth.enabled` (default true); Go's viper AutomaticEnv
  // binds `auth.enabled` to `SUPABASE_AUTH_ENABLED` before Validate (`config.go:529-535`), so the
  // env override decides whether the auth block is validated — UNLESS a matched `[remotes.*]`
  // block supplies `auth.enabled` itself, in which case `mergeRemoteConfig`'s `v.Set` (override
  // tier, above `AutomaticEnv`) wins, matching the same suppression every other
  // `LEGACY_ENV_OVERRIDABLE_KEYS` entry gets below.
  const authEnabled = yield* resolveBoolOrFail(
    "auth.enabled",
    authRaw?.["enabled"],
    true,
    lookup,
    remoteOverrideKeys.has("auth.enabled") ? undefined : envOverride("SUPABASE_AUTH_ENABLED"),
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
    // A1: site_url required (`config.go:1037-1039`).
    const siteUrl =
      authRawResolved["site_url"] === undefined
        ? DEFAULT_AUTH_SITE_URL
        : str(authRawResolved, "site_url");

    // A4: [auth.captcha]. The provider enum is a decode-time check (`CaptchaProvider.
    // UnmarshalText`, `auth.go:58-71`); the required-field checks are `enabled`-gated
    // (`config.go:1048-1058`) — both now live in `legacyValidateResolvedConfig`.
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

    // A5: signing keys file load (`config.go:1059-1065`) — I/O, stays in D. A relative path
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

    // A6: passkey/webauthn when passkey enabled (`config.go:1066-1084`).
    const passkeyRaw = asRecord(authRawResolved["passkey"]);
    let passkeyInput: LegacyPasskeyInput | undefined;
    if (passkeyRaw !== undefined && (yield* gate(passkeyRaw, "enabled", "auth.passkey.enabled"))) {
      const webauthnRaw = asRecord(authRawResolved["webauthn"]);
      const rpOrigins = webauthnRaw?.["rp_origins"];
      passkeyInput = {
        webauthnPresent: webauthnRaw !== undefined,
        rpId: str(webauthnRaw, "rp_id"),
        rpOrigins: Array.isArray(rpOrigins) ? rpOrigins : undefined,
      };
    }

    // B1: hooks — each enabled hook, Go's fixed iteration order (`config.go:1402-1470`).
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

    // B2: mfa — enroll requires verify (`config.go:1472-1483`), fixed totp/phone/web_authn order.
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

    // B3: email (`config.go:1242-1295`) — template/notification content is I/O, stays in D. Go
    // resolves a relative `content_path` differently per section: TEMPLATE paths are relative to
    // the PROJECT ROOT (`config.go:854-856`, the `// FIXME` there), NOTIFICATION paths are
    // relative to the supabase dir (`config.go:861-862`); absolute → as-is.
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
              base: supabaseDir,
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
    // but omits `enabled` (`config.go:692-696`), so a present table validates unless explicitly
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

    // B6: third_party — each enabled provider, Go's fixed order (`config.go:1584-1632`). Note
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

  // Go's config.Validate validates `[analytics]` after the auth block (`config.go:1123-1135`).
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
  const analyticsString = (key: string, envName: string): string => {
    const fromEnv = remoteOverrideKeys.has(`analytics.${key}`) ? undefined : envOverride(envName);
    const raw = fromEnv ?? analyticsRaw?.[key];
    return typeof raw === "string" ? legacyExpandEnv(raw, lookup) : "";
  };
  const analyticsBackend = analyticsString("backend", "SUPABASE_ANALYTICS_BACKEND");
  const analyticsEnabled = yield* resolveBoolOrFail(
    "analytics.enabled",
    analyticsRaw?.["enabled"],
    true,
    lookup,
    remoteOverrideKeys.has("analytics.enabled")
      ? undefined
      : envOverride("SUPABASE_ANALYTICS_ENABLED"),
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
    // B4: sms — D-only (`config.go:1145-1147`/`1348-1417`, never part of the shared validator,
    // see `legacy-config-validate.ts`'s module header). Only the FIRST enabled provider is
    // validated (Go's switch).
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

    // B5: external providers — D-only (`config.go:1148-1150`/`1368-1398`, never part of the
    // shared validator). linkedin/slack are deprecated and deleted before validation, so they are
    // never validated here.
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

  // `[db.vault]` secret names, sorted (Go's `setupInputsToken` sorts before hashing).
  const vaultRaw = asRecord(db?.["vault"]);
  const vaultNames = vaultRaw === undefined ? [] : Object.keys(vaultRaw).sort();

  // `[db.migrations] enabled` — Go default true (`config.go:384`); overridable by
  // `SUPABASE_DB_MIGRATIONS_ENABLED` via viper AutomaticEnv (`config.go:494-498`) — EXCEPT
  // when the matched remote block explicitly set it (then the remote override-tier value
  // wins, `config.go:635-637`).
  const migrationsRaw = asRecord(db?.["migrations"]);
  const migrationsEnabled = yield* resolveBoolOrFail(
    "db.migrations.enabled",
    migrationsRaw?.["enabled"],
    true,
    lookup,
    remoteOverrideKeys.has("db.migrations.enabled")
      ? undefined
      : envOverride("SUPABASE_DB_MIGRATIONS_ENABLED"),
  );

  // `[db.seed]` — Go defaults enabled true, sql_paths ["seed.sql"]; relative
  // patterns are supabase-prefixed (`config.go:801-806`). `db.seed.enabled` is
  // overridable by `SUPABASE_DB_SEED_ENABLED` via viper AutomaticEnv — EXCEPT when a
  // matched remote block supplied it at the override tier (set or forced false).
  const seedRaw = asRecord(db?.["seed"]);
  const seedEnabled = yield* resolveBoolOrFail(
    "db.seed.enabled",
    seedRaw?.["enabled"],
    true,
    lookup,
    remoteOverrideKeys.has("db.seed.enabled") ? undefined : envOverride("SUPABASE_DB_SEED_ENABLED"),
  );
  // Go decodes `db.seed.sql_paths` through the mapstructure hook chain in order:
  // `LoadEnvHook` (expands `env(VAR)`) runs BEFORE `StringToSliceHookFunc(",")`
  // (`config.go:687-695`; `decode_hooks.go`). So a STRING value — the
  // `SUPABASE_DB_SEED_SQL_PATHS` env override (viper AutomaticEnv) or a TOML string — is
  // env-expanded FIRST, then comma-split (no trimming; empty → `[]`). A TOML ARRAY is
  // decoded element-by-element: each element is env-expanded but NOT re-split
  // (`StringToSliceHookFunc` only fires string→[]string), so `["env(SEEDS)"]` stays one
  // pattern. The env override (non-empty; `envOverride` drops empties to match
  // `AllowEmptyEnv=false`) wins over the TOML value; an absent (or non-string/non-array)
  // value falls back to the `["seed.sql"]` default.
  const splitGoSeedPaths = (value: string): ReadonlyArray<string> => {
    const expanded = legacyExpandEnv(value, lookup);
    return expanded.length === 0 ? [] : expanded.split(",");
  };
  const rawSqlPaths = seedRaw?.["sql_paths"];
  const sqlPathsOverride = remoteOverrideKeys.has("db.seed.sql_paths")
    ? undefined
    : envOverride("SUPABASE_DB_SEED_SQL_PATHS");
  const sqlPathPatterns =
    sqlPathsOverride !== undefined
      ? splitGoSeedPaths(sqlPathsOverride)
      : Array.isArray(rawSqlPaths)
        ? rawSqlPaths
            .filter((pattern): pattern is string => typeof pattern === "string")
            .map((pattern) => legacyExpandEnv(pattern, lookup))
        : typeof rawSqlPaths === "string"
          ? splitGoSeedPaths(rawSqlPaths)
          : ["seed.sql"];
  // Patterns are already env-expanded above (Go's LoadEnvHook runs before the split);
  // resolve each to Go's config-load form (absolute verbatim, relative supabase-joined).
  const seedSqlPaths = sqlPathPatterns.map((pattern) => legacyResolveSeedSqlPath(path, pattern));

  // `[db.vault]` secrets: env-expand each value, then decrypt dotenvx `encrypted:`
  // ciphertext. `resolved` mirrors Go's `len(SHA256) > 0` gate (Go sets SHA256 only
  // after a successful decrypt-or-passthrough; `UpsertVaultSecrets` upserts only
  // resolved secrets). Go's `DecryptSecretHookFunc` runs inside `config.Load`, so an
  // `encrypted:` value that cannot be decrypted aborts the command with
  // `failed to parse config: <error>` (`secret.go:30-73`, `config.go:661-667`) — it
  // is never silently skipped, which an earlier port did and which diverged from Go.
  const vault: Array<LegacyDbVaultSecretToml> = [];
  if (vaultRaw !== undefined) {
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

  // `[api] auto_expose_new_tables` is a tri-state `*bool` (`pkg/config/api.go:25`):
  // present → Some(bool), absent → None (never false). Go applies the
  // `SUPABASE_API_AUTO_EXPOSE_NEW_TABLES` AutomaticEnv override and decodes the value
  // with `strconv.ParseBool`, failing the load on a malformed value — so `1`/`TRUE`/
  // `env(...)` parse correctly and `maybe` aborts rather than silently coercing to false.
  const apiAutoExposeNewTables = yield* resolveOptionalBoolOrFail(
    "api.auto_expose_new_tables",
    remoteOverrideKeys.has("api.auto_expose_new_tables")
      ? undefined
      : envOverride("SUPABASE_API_AUTO_EXPOSE_NEW_TABLES"),
    apiRaw?.["auto_expose_new_tables"],
    lookup,
  );

  const values: LegacyDbTomlValues = {
    envLookup: envOverride,
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
    seed: { enabled: seedEnabled, sqlPaths: seedSqlPaths },
    vault,
    appliedRemote,
  };
  return values;
});

/**
 * Read + validate `config.toml` exactly like Go's `flags.LoadConfig` → `config.Load`
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
) => readDbTomlCore(fs, path, workdir, ref, false);

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
  opts?: { readonly validate?: boolean },
) =>
  opts?.validate === false
    ? readDbTomlCore(fs, path, workdir, ref, false).pipe(
        // Fall back to the ignore-file defaults path (never re-reads the broken config)
        // so a best-effort caller gets a well-formed defaults result instead of a throw.
        Effect.catchTag("LegacyDbConfigLoadError", () =>
          readDbTomlCore(fs, path, workdir, ref, true),
        ),
      )
    : readDbTomlCore(fs, path, workdir, ref, false);

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
