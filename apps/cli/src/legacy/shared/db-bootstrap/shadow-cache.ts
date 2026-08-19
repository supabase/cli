/**
 * Baseline cache — the acquire/release pair `db diff`/`db pull`/the migrations-catalog
 * resolution path use in place of bare `legacyCreateShadowDatabase`/`legacyRemoveShadowDatabase`
 * (`shadow-database.ts`). Caches a cluster's platform baseline (init schema + the PG15+ one-shot
 * realtime/storage/auth jobs) as a disk-level PGDATA snapshot, never a kept container.
 *
 * The tar pool is SHARED with the long-running local `db` container: `main-db-baseline.ts` keys,
 * restores, and publishes through this same module — same directory, same `shadow-baseline-<key>`
 * names (kept as-is so both producers stay interchangeable), same LRU/TTL sweep. A `db diff` run
 * therefore warms the snapshot a later `supabase db reset` restores, and vice versa. Everything
 * that genuinely differs between the two clusters is already a key input (the `postgres` password
 * in particular: the main container is always initialized with the `"postgres"` literal, the
 * shadow with `[db] password`), so a tar is only ever reachable from a cluster it fits.
 *
 * - **Cold** (no snapshot for this key): provision the shadow as an uncached run does, then —
 *   right after the baseline and before `contrib_regression`/any user migration — stop the
 *   container, export its PGDATA via {@link legacyExportPgDataTar} (`pgdata-snapshot.ts`), and
 *   start it again.
 * - **Warm** (that tar exists): create the shadow with the tar unpacked into it before it starts
 *   ({@link legacyPgDataRestoreArchive}), so the entrypoint skips `initdb` and the whole baseline;
 *   the caller applies user migrations straight onto the restored `postgres`.
 *
 * Invariants: the artifact is a plain file, not a Docker object (native-services friendly — see
 * `pgdata-snapshot.ts`'s own header); no container outlives a run — cold, warm, and cache-off
 * shadows are all removed with `docker rm -f -v` on release; the cold path alone drops `--rm` (see
 * {@link LegacyCreateShadowDatabaseInput.autoRemove} for the consequence); the tar is published by
 * an atomic rename, so concurrent writers need no lock file; a cache anomaly never fails the run —
 * a warm-path anomaly cold-provisions (deleting the tar only when its contents are implicated —
 * see `LegacyShadowCacheUnavailable.tarSuspect`), a cold export failure only warns and leaves the
 * run uncached (with ONE deliberate exception: a shadow that fails to come back up after the
 * snapshot fails the run — see `legacyExportShadowBaseline`); same-PROCESS concurrent exports are
 * additionally serialized by an in-process mutex, because `legacyExportPgDataTar`'s temp name is
 * pid-scoped and two fibers of one process would otherwise share it (see
 * {@link legacyWriteShadowBaselineTar}); tars live under the global
 * `${SUPABASE_HOME}/cache/shadow-baseline/` (shared across worktrees with the same settings),
 * with LRU (keep 8) + 14-day mtime TTL retention. `SUPABASE_SHADOW_CACHE` is ON by default;
 * `false`/`0` opts out.
 */

import { createHash } from "node:crypto";

import type { ProjectConfig } from "@supabase/config";
import { Clock, Data, Effect, Option, Result, Semaphore, type FileSystem, type Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { Output } from "../../../shared/output/output.service.ts";
import type { LocalServiceVersionOverrides } from "../../../shared/services/services.shared.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";
import {
  containerCliExitCode,
  legacyDescribeContainerCliFailure,
} from "../legacy-container-cli.ts";
import { LegacyDbConnection } from "../legacy-db-connection.service.ts";
import type { LegacyPgConnInput } from "../legacy-db-connection.service.ts";
import { legacyGetRegistryImageUrl } from "../legacy-docker-registry.ts";
import { legacyShadowBaselineCacheDir } from "../legacy-pgdelta.paths.ts";
import { legacyParseBoolEnv } from "../legacy-diff-engine.ts";
import { LEGACY_POSTGRES_DEFAULT_ROOT_KEY } from "../legacy-local-config-values.ts";
import {
  LEGACY_START_ENABLE_DATABASE_WEBHOOKS_SQL,
  LEGACY_START_REVOKE_API_PRIVILEGES_SQL,
  type LegacySetupDatabaseOptions,
} from "./db-setup.ts";
import {
  LEGACY_START_INTERNAL_DB_NAME,
  LEGACY_START_INTERNAL_DB_PORT,
} from "./internal-db-connection.ts";
import {
  LEGACY_REALTIME_DB_USER,
  LEGACY_REALTIME_ENCRYPTION_KEY,
  LEGACY_REALTIME_TENANT_ID,
} from "./realtime-env.ts";
import { LEGACY_START_DB_SCHEMA_SQL } from "./templates/db-schema.sql.ts";
import { LEGACY_START_DB_SUPABASE_SQL } from "./templates/db-supabase.sql.ts";
import { LEGACY_START_DB_WEBHOOK_SQL } from "./templates/db-webhook.sql.ts";
import {
  LEGACY_CREATE_VAULT_KV,
  LEGACY_READ_VAULT_KV,
  LEGACY_UPDATE_VAULT_KV,
  type LegacyVaultSecret,
} from "../legacy-vault.ts";
import { legacyWaitForShadowReady } from "./health-check.ts";
import {
  legacyExportPgDataTar,
  legacyPgDataRestoreArchive,
  legacyStampPgDataBaselineMarker,
  legacyValidatePgDataArchive,
} from "./pgdata-snapshot.ts";
import type {
  LegacyPgDataArchiveProblem,
  LegacyPgDataSnapshotUnavailable,
} from "./pgdata-snapshot.ts";
import { legacyResolvePinnedImage } from "./pinned-image.ts";
import { legacyTimeShadowPhase } from "./shadow-debug.ts";
import {
  legacyCreateShadowDatabase,
  legacyRemoveShadowDatabase,
  type LegacyShadowBaselineState,
  LegacyShadowDbError,
  type LegacyShadowSetupInput,
} from "./shadow-database.ts";

type Spawner = ChildProcessSpawner["Service"];

/** `SUPABASE_SHADOW_CACHE` — the opt-OUT gate for this whole module (default ON). */
export const LEGACY_SHADOW_CACHE_ENV = "SUPABASE_SHADOW_CACHE";

/**
 * Internal-only "the cache cannot be used" signal. Deliberately NOT a `Data.TaggedError`: it
 * never reaches a user or telemetry — every producer is caught by
 * {@link legacyAcquireShadowDatabase} (which falls back to a cold provision) or by
 * {@link legacyExportShadowBaseline} (which warns and continues uncached), so classifying it as a
 * CLI error would be misleading, and would pollute the error-actionability vocabulary with a
 * failure the user can neither see nor act on.
 */
interface LegacyShadowCacheUnavailable {
  readonly reason: string;
  /**
   * `true` only when the failure implicates the TAR'S CONTENTS — today, exactly three producers,
   * all in {@link legacyWarmShadow}: an archive whose header stream is missing a required entry —
   * the PGDATA cluster file or the baseline marker; one whose marker vouches for a DIFFERENT cache
   * key than the filename it is stored under (both checked before any container is created); and a
   * restored cluster that started but never
   * accepted connections (the readiness wait). The wrong-key case is the one where the bytes may
   * be a perfectly good snapshot — of another key — so what is discarded is only the MISNAMED
   * COPY, which is exactly right: nothing else can be keyed by this filename.
   * Everything else (a `docker create`/`cp`/`start`
   * failure — daemon outage,
   * port collision, or even a corrupt archive's failed extraction) leaves the tar in place: an
   * infra failure says nothing about the tar, and a genuinely corrupt one is atomically
   * REPLACED by the cold fallback's own export in the same run, so deleting up front would only
   * throw away a valid ~15s-to-rebuild baseline on transient Docker failures (review: Codex on
   * #6184).
   */
  readonly tarSuspect?: boolean;
}

const legacyShadowCacheUnavailable = (
  reason: string,
  opts: { readonly tarSuspect?: boolean } = {},
): LegacyShadowCacheUnavailable => ({ reason, ...opts });

/**
 * Whether the shadow baseline cache is enabled for this invocation.
 *
 * Unset (or empty) means ON — this is a default-on optimization, not a feature flag. A value that
 * IS set goes through the repo's `viper.GetBool` parser, so `SUPABASE_SHADOW_CACHE=false` and
 * `=0` opt out while `=1`/`=true` are explicit opt-ins.
 *
 * `projectEnvValues` (the project's dotenv-merged env, ambient-wins — see
 * `legacyGetRegistryOverride`'s identical parameter, `legacy-docker-registry.ts`) is consulted
 * first so an opt-out set only in `supabase/.env` is honored, matching how Go's `loadNestedEnv`
 * makes project dotenv visible to every viper read (review: Codex on #6184). Falls back to `env`
 * (ambient) when the record is absent or lacks the key.
 */
export function legacyShadowCacheEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
  projectEnvValues?: Readonly<Record<string, string>>,
): boolean {
  const raw = projectEnvValues?.[LEGACY_SHADOW_CACHE_ENV] ?? env[LEGACY_SHADOW_CACHE_ENV];
  if (raw === undefined || raw.length === 0) return true;
  return legacyParseBoolEnv(raw);
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/** One of the three PG15+ one-shot migrate jobs, as the cache key sees it. */
export interface LegacyShadowCacheServiceInput {
  readonly enabled: boolean;
  /**
   * `legacyResolvePinnedImage`'s pinned image passed through `legacyGetRegistryImageUrl` — the
   * REGISTRY-RESOLVED ref, not the bare `supabase/<name>:<tag>` pin, because that is the identity
   * `legacyRunStartMigrateJob`'s own `legacyEnsureImagesCached` resolve actually runs: a changed
   * `SUPABASE_INTERNAL_IMAGE_REGISTRY` (ambient or project-`.env`) can serve a different image
   * under the same tag, and the postgres image field above is already the registry-resolved form
   * (review: Codex on #6184). Hashed ONLY when {@link enabled}, since a disabled service's job
   * never ran into the baseline.
   */
  readonly image: string;
}

/**
 * Every input baked into the shadow cluster during a cold provision. Deliberately NOT
 * `legacySetupInputsToken`'s shape (`legacy-pgdelta.cache.ts`): that key is a Go-parity
 * byte-for-byte contract shared with the Go binary AND hashes vault NAMES only while omitting
 * the one-shot job image tags — both fatal for a CLUSTER snapshot, which carries the vault
 * secrets' values and the versioned `auth`/`storage`/`_realtime` schema those jobs write. This
 * key mirrors that function's hashing STYLE (sha256 over newline-joined formatted fields) without
 * reusing it.
 *
 * **One container-shape difference is deliberately NOT hashed**, and it is the one to re-check
 * before adding a baseline step: the shadow bootstraps under `-c max_worker_processes=0`
 * (`legacyBuildShadowPostgresContainerSpec`, `postgres.service.ts`) while the long-running local
 * `db` container this pool is shared with does not. That is safe today because the flag is
 * command-line-only — the entrypoint never persists it into PGDATA, so a tar produced under it
 * behaves identically once restored into either cluster — and because no baseline step depends on
 * a live background worker. A future step that DOES (waiting on pg_net's queue worker to drain,
 * say) would silently produce two different baselines under one key, and must add the worker
 * setting to this shape before it lands.
 */
export interface LegacyShadowCacheKeyInputs {
  /** The resolved, full `supabase/postgres` image (tag included — a major version is not enough). */
  readonly postgresImage: string;
  readonly majorVersion: number;
  readonly jwtSecret: string;
  readonly jwtExpiry: number;
  readonly rootKey: string;
  /** `[db] password` — baked into the cluster as the `postgres` role's password. */
  readonly dbPassword: string;
  /**
   * The Storage migration pin read from `supabase/.temp/storage-migration` (written by
   * `supabase link`), fed as `DB_MIGRATIONS_FREEZE_AT` to the Storage one-shot migrate job
   * (`legacyStartStorageMigrateEnv`, `db-setup.ts`) — it decides WHICH Storage migrations the
   * baseline carries, independently of the job image's own tag. `""` when absent (unlinked
   * project), matching the setup input's own zero value. Hashed ONLY when `services.storage`
   * is enabled AND `majorVersion >= 15` — the exact compound gate `legacyStartInitSchema15`
   * (`db-setup.ts`) puts the consuming job behind, mirroring {@link jwks}'s treatment
   * (review: depthfirst/Codex on #6184).
   */
  readonly storageTargetMigration: string;
  readonly dbSettings: ProjectConfig["db"]["settings"];
  /**
   * `api.auto_expose_new_tables` as config carries it. Hashed as the EFFECTIVE two-state behavior,
   * not the raw tri-state — see {@link legacyEffectiveShadowApiGrantsKept}.
   */
  readonly autoExposeNewTables: Option.Option<boolean>;
  /**
   * Effective Webhooks/`pg_net` policy baked into the cluster — the same boolean
   * `legacySetupDatabase` applies (`options.webhooks` resolved against
   * `setup.webhooksEnabled`). Distinct from the raw config flag: legacy migrate
   * forces enabled, next declarative forces disabled, and next migrate follows
   * config. Hashed so those callers cannot share a snapshot (review: Codex/
   * depthfirst on #6184).
   */
  readonly webhooksEnabled: boolean;
  /** `supabase/roles.sql`'s contents, `""` when absent. */
  readonly rolesSql: string;
  /**
   * `[db.vault]` secrets — names AND values, both of which land in `vault.secrets`. Only
   * RESOLVED entries are hashed ({@link legacyShadowCacheKey}), because the upsert skips
   * unresolved ones entirely — see the loop's own comment there.
   */
  readonly vault: ReadonlyArray<LegacyVaultSecret>;
  readonly services: {
    readonly realtime: LegacyShadowCacheServiceInput;
    readonly storage: LegacyShadowCacheServiceInput;
    readonly auth: LegacyShadowCacheServiceInput;
  };
  /**
   * The resolved JWKS string (`LegacyShadowDbSetupInput.jwks`, an `Effect` the caller resolves
   * lazily) that realtime's one-shot tenant-seed job bakes into the cluster
   * (`legacyBuildRealtimeEnv`'s `jwks` field, `db-setup.ts`) — a config change under
   * `auth.third_party` changes this value without touching anything else in this struct, so it
   * needs its own field rather than folding into `services.realtime`. Hashed ONLY when
   * `services.realtime` is enabled AND `majorVersion >= 15` — the exact compound gate
   * {@link legacyResolveDbSetupPrelude} itself uses to decide whether to resolve (and therefore
   * whether the one-shot job ever consumes) this same effect during a real setup: a disabled or
   * pre-PG15 realtime never reaches the job that reads it. `""` when excluded, mirroring
   * {@link LegacyShadowCacheServiceInput.image}.
   */
  readonly jwks: string;
}

/**
 * Digest of every CLI-EMBEDDED literal baked into the baseline cluster — the inputs that change
 * with a CLI release rather than with the project's config: the PG15+ entrypoint's initdb heredocs
 * (schema/webhook/_supabase — `postgres.service.ts`), the API privilege revocation, and the
 * Realtime one-shot job's seed constants. Without this line, a CLI upgrade that edits a grant,
 * schema statement, revocation, or seeded literal WITHOUT bumping the corresponding image would
 * warm-restore the previous release's baseline (review: depthfirst/Codex on #6184). Computed once
 * at module load — these are compile-time constants. When adding a new embedded step to the
 * baseline (`legacySetupDatabase`/the entrypoint scripts/a one-shot job's env), add its text here
 * too.
 *
 * Deliberately EXCLUDES PG<=14's own setup SQL (`LEGACY_START_DB_GLOBALS_SQL`,
 * `LEGACY_START_DB_INITIAL_SCHEMA_13_SQL`/`_14_SQL`): PG<=14 is cache-ineligible —
 * {@link legacyResolveShadowCacheKeyInputs} returns `Option.none()` for `majorVersion <= 14` before
 * any key is computed, so no cluster keyed by this digest can ever have run through that SQL. If
 * PG<=14 ever becomes cache-eligible, those templates must be re-added here.
 */
const LEGACY_SHADOW_BASELINE_EMBEDDED_DIGEST = createHash("sha256")
  .update(
    [
      LEGACY_START_DB_SCHEMA_SQL,
      LEGACY_START_DB_WEBHOOK_SQL,
      LEGACY_START_DB_SUPABASE_SQL,
      LEGACY_START_REVOKE_API_PRIVILEGES_SQL,
      // The webhooks-enable statement `legacySetupDatabase` runs for a webhooks-enabled baseline
      // (`db-setup.ts`). `webhooksEnabled` above only says WHETHER it ran; this line covers the
      // text it ran, so editing the statement re-keys those tars too (review: Codex on #6184).
      LEGACY_START_ENABLE_DATABASE_WEBHOOKS_SQL,
      // The vault upsert's own SQL (`legacyUpsertVaultSecrets`, `legacy-vault.ts`) runs into the
      // baseline right after the privilege pass — same digest rationale as every line above.
      LEGACY_READ_VAULT_KV,
      LEGACY_UPDATE_VAULT_KV,
      LEGACY_CREATE_VAULT_KV,
      // The Realtime one-shot job's CLI-embedded seed literals. `SEED_SELF_HOST=true`
      // (`legacyBuildRealtimeEnv`, `realtime-env.ts`) makes that job PERSIST a tenant plus its
      // `postgres_cdc_rls` extension settings into `_realtime`, encrypted with `DB_ENC_KEY` — so
      // these values are baked into the snapshot exactly like the SQL above, and every one of them
      // is a `toml:"-"`/hardcoded literal a CLI release can edit. `services.realtime.image` only
      // re-keys when the IMAGE moves, so without these lines such an edit would warm-restore the
      // old tenant identity and encryption key (review: Codex on #6184). Only the CONSTANTS
      // belong here: the job's per-run env (the shadow's own short container id as `DB_HOST`, its
      // password, the resolved JWKS) is either already a key field or deliberately excluded.
      LEGACY_REALTIME_TENANT_ID,
      LEGACY_REALTIME_ENCRYPTION_KEY,
      LEGACY_REALTIME_DB_USER,
      LEGACY_START_INTERNAL_DB_NAME,
      String(LEGACY_START_INTERNAL_DB_PORT),
    ].join("\n--8<--\n"),
    "utf8",
  )
  .digest("hex");

/** JSON with recursively key-sorted objects, so `db.settings`' own property order cannot change the key. */
function legacyCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(legacyCanonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${legacyCanonicalJson(entryValue)}`).join(",")}}`;
}

const legacyBoolToken = (value: boolean) => (value ? "true" : "false");

/**
 * The two-state behavior `legacyApplyApiPrivileges` (`db-setup.ts`) actually derives from
 * `api.auto_expose_new_tables`' tri-state: it returns early ONLY for an explicit `true`, so unset
 * and explicit `false` both exec {@link LEGACY_START_REVOKE_API_PRIVILEGES_SQL} and bake the exact
 * same cluster. Hashing the raw tri-state would split those two into different keys and force a
 * spurious ~90MB re-snapshot for a config edit that changes nothing on disk (review: Codex on
 * #6184).
 */
const legacyEffectiveShadowApiGrantsKept = (value: Option.Option<boolean>): boolean =>
  Option.getOrElse(value, () => false);

/**
 * The cache key: a 16-hex-char (64-bit) sha256 prefix over a fixed field order. 64 bits is
 * ample for a per-settings global cache whose only cost of a collision would be a wrong baseline
 * — and every genuinely divergent input is in the payload, so a collision needs an actual hash
 * collision, not a missed field. Short enough to read in a filename.
 */
export function legacyShadowCacheKey(inputs: LegacyShadowCacheKeyInputs): string {
  // Every UNRESTRICTED string is JSON-encoded before interpolation (`quoted`): a raw newline in
  // one field could otherwise forge a whole extra payload line, letting two distinct
  // configurations collide (review: Codex on #6184 — same class as the vault tuples below).
  // Numbers and closed tokens need no quoting; `rolesSql` stays raw because it is the
  // documented LAST field, with nothing after it to forge.
  const quoted = (value: string) => JSON.stringify(value);
  const lines: Array<string> = [
    `postgres_image=${quoted(inputs.postgresImage)}`,
    `major_version=${inputs.majorVersion}`,
    // Host publish port is deliberately excluded: it is not baked into PGDATA, and
    // pg-delta next allocates an ephemeral port per shadow. Hashing it would miss
    // every warm hit on that path. Restore always uses the current run's port.
    `jwt_secret=${quoted(inputs.jwtSecret)}`,
    `jwt_expiry=${inputs.jwtExpiry}`,
    `root_key=${quoted(inputs.rootKey)}`,
    `db_password=${quoted(inputs.dbPassword)}`,
    `db_settings=${legacyCanonicalJson(inputs.dbSettings)}`,
    `api_grants_kept=${legacyBoolToken(legacyEffectiveShadowApiGrantsKept(inputs.autoExposeNewTables))}`,
    `webhooks_enabled=${legacyBoolToken(inputs.webhooksEnabled)}`,
    // Not a per-run input — see the digest's own doc comment for what it covers and why.
    `baseline_embedded_digest=${LEGACY_SHADOW_BASELINE_EMBEDDED_DIGEST}`,
  ];
  for (const name of ["realtime", "storage", "auth"] as const) {
    const service = inputs.services[name];
    lines.push(
      service.enabled
        ? `service=${name} enabled=true image=${quoted(service.image)}`
        : `service=${name} enabled=false`,
    );
  }
  // Realtime's resolved JWKS — see the field's own doc comment for the compound
  // enabled+majorVersion gate (mirrors `service=realtime`'s own `enabled` exclusion above, plus
  // the PG15+ gate the one-shot job itself is behind).
  lines.push(
    inputs.services.realtime.enabled && inputs.majorVersion >= 15
      ? `realtime_jwks=${quoted(inputs.jwks)}`
      : "realtime_jwks=excluded",
  );
  // Storage's migration pin — same compound enabled+majorVersion gate as the JWKS line above,
  // because the consuming one-shot job (`legacyStartInitSchema15`) is behind the same gate.
  lines.push(
    inputs.services.storage.enabled && inputs.majorVersion >= 15
      ? `storage_target_migration=${quoted(inputs.storageTargetMigration)}`
      : "storage_target_migration=excluded",
  );
  // ONLY resolved entries: `legacyUpsertVaultSecrets` (`legacy-vault.ts`) filters on
  // `secret.resolved` before touching `vault.secrets`, so an unresolved entry never lands in
  // the cluster and must not affect the key — hashing exactly what the upsert processes
  // (review: Codex on #6184).
  for (const secret of inputs.vault
    .filter((secret) => secret.resolved)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    // JSON-encoded tuple, not `name=value`: both halves are unrestricted strings, so a bare
    // `=` join would let (`a=b`, `c`) and (`a`, `b=c`) collide — and a value containing a
    // newline could forge a whole extra payload line (review: Codex on #6184).
    lines.push(`vault=${JSON.stringify([secret.name, secret.value])}`);
  }
  // Last, raw (it can contain anything, including newlines) — mirroring `setupInputsToken`,
  // which also appends `roles.sql` verbatim at the end of its own payload.
  const payload = `${lines.join("\n")}\nroles_sql=\n${inputs.rolesSql}`;
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

/**
 * Same resolution `legacySetupDatabase` applies (`db-setup.ts`): `"enabled"` always
 * installs `pg_net`, `"disabled"` always removes it, `"config"` (the default) follows
 * `setup.webhooksEnabled`.
 */
export function legacyEffectiveShadowWebhooksEnabled(
  policy: LegacySetupDatabaseOptions["webhooks"],
  webhooksEnabled: boolean,
): boolean {
  const webhooks = policy ?? "config";
  return webhooks === "enabled" || (webhooks === "config" && webhooksEnabled);
}

/**
 * The filesystem handles every artifact-side helper in this module needs — nothing cluster- or
 * key-specific. Both {@link LegacyBaselineCacheInput} and `main-db-baseline.ts`'s own input
 * satisfy it structurally.
 */
export interface LegacyBaselineCacheFiles {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/**
 * Everything the cache key is computed from, as a STRUCTURAL shape rather than the shadow's own
 * run input: `LegacyShadowSetupInput` (`shadow-database.ts`) satisfies it as-is, and so does the
 * long-running local `db` container's equivalent (`main-db-baseline.ts`), which shares this
 * module's tar pool. Deliberately narrow — a field only belongs here if
 * {@link legacyResolveShadowCacheKeyInputs} actually reads it, so neither producer is forced to
 * invent a value for a field the other one owns (the shadow's own host port, the main
 * container's volume name).
 */
export interface LegacyBaselineCacheInput<E> extends LegacyBaselineCacheFiles {
  readonly workdir: string;
  /** The resolved, registry-rewritten `supabase/postgres` image the cluster runs. */
  readonly image: string;
  readonly db: Pick<ProjectConfig["db"], "major_version" | "settings">;
  readonly experimental: ProjectConfig["experimental"];
  readonly jwtSecret: string;
  readonly jwtExpiry: number;
  readonly rootKey?: string;
  /** The cluster's own `POSTGRES_PASSWORD` — see {@link LegacyShadowCacheKeyInputs.dbPassword}. */
  readonly password: string;
  readonly setup: {
    readonly majorVersion: number;
    readonly config: ProjectConfig;
    readonly webhooksEnabled: boolean;
    readonly jwks: Effect.Effect<string, E>;
    readonly storageTargetMigration: string;
    readonly serviceVersionOverrides: LocalServiceVersionOverrides;
    readonly projectEnvValues: Readonly<Record<string, string>> | undefined;
    readonly apiAutoExposeNewTables: Option.Option<boolean>;
    readonly vault: ReadonlyArray<LegacyVaultSecret>;
  };
}

/**
 * Resolves {@link LegacyShadowCacheKeyInputs} from the same run input the cluster
 * itself is built from, plus `supabase/roles.sql` off disk. The service enabled flags come from
 * `setup.config` (NOT the `*EnabledForSetup` fields, which only gate JWKS resolution) because
 * `legacySetupDatabase`'s own one-shot job gates read exactly those config fields.
 *
 * Returns `Option.none` (never a failure) for the two conditions that make caching
 * unavailable — an OrioleDB cluster (whose state is partly external, see the body's own
 * comment) and an unreadable `roles.sql` — so this function's OWN error channel carries
 * nothing but `E`: the `input.setup.jwks` effect below is `yield*`ed unguarded (only when the
 * consuming realtime job is actually reachable — see the field's own doc comment), and a real
 * JWKS failure must fail this whole acquire exactly as it would have failed a real setup, never
 * be folded into a cache-miss the way {@link LegacyShadowCacheUnavailable} failures are
 * elsewhere in this module. Keeping the two failure modes on separate channels (`Option.none`
 * vs. a genuine `Effect` failure) is what lets the caller (`legacyAcquireShadowDatabase`)
 * degrade the former to an uncached shadow while letting the latter propagate, without an `as`
 * cast to tell them apart.
 */

const legacyResolveShadowCacheKeyInputs = <E>(
  input: LegacyBaselineCacheInput<E>,
  opts: LegacyShadowCacheOpts = {},
): Effect.Effect<Option.Option<LegacyShadowCacheKeyInputs>, E> =>
  Effect.gen(function* () {
    // OrioleDB (`experimental.orioledb_version`) makes the WHOLE cache ineligible, not just a
    // key input: that branch runs the shadow with an external S3 storage backend
    // (`S3_ENABLED=true` — `legacyPostgresExtraEnv`, `postgres.service.ts`), so part of the
    // cluster's state lives outside PGDATA and a disk-level tar is not a coherent snapshot to
    // begin with (review: Codex on #6184). Same `Option.none` degradation as an unreadable
    // `roles.sql` below: the run proceeds uncached.
    const orioledbVersion = input.experimental.orioledb_version;
    if (orioledbVersion !== undefined && orioledbVersion.length > 0) return Option.none();

    // PG <= 14 is cache-ineligible too: its setup path executes the bundled globals SQL
    // (`LEGACY_START_DB_GLOBALS_SQL`, `db-setup.ts`'s pre-15 branch), whose `ALTER ROLE … SET`
    // statements (statement_timeout, `postgres`'s search_path) only take effect on NEW sessions.
    // Go/uncached runs apply migrations on the SAME session that ran the setup — before those
    // defaults exist — while any snapshot boundary forces a reconnect that picks them up, so
    // unqualified names in user migrations could resolve into different schemas and change the
    // diff (review: Codex on #6184). PG15+ moves that SQL into the entrypoint's initdb heredoc,
    // which runs before any CLI session, so no session ever observes a mid-run change there.
    if (input.setup.majorVersion <= 14) return Option.none();

    const rolesPath = input.path.join(input.workdir, "supabase", "roles.sql");
    const rolesSql = yield* input.fs
      .readFileString(rolesPath)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.succeed(undefined),
        ),
      );
    if (rolesSql === undefined) return Option.none();

    const overrides = input.setup.serviceVersionOverrides;
    // The same registry rewrite `legacyRunStartMigrateJob`'s `legacyEnsureImagesCached` applies
    // when the job actually runs (same `projectEnvValues`-then-ambient precedence) — see
    // {@link LegacyShadowCacheServiceInput.image}.
    const resolveJobImage = (image: string): string =>
      legacyGetRegistryImageUrl(image, input.setup.projectEnvValues);
    // The exact compound gate {@link legacyResolveDbSetupPrelude} uses to decide whether the
    // realtime one-shot job's JWKS effect is reached (and therefore run) at all during a real
    // setup — see `db-setup.ts`. Gating on anything looser here would resolve (and risk failing
    // on) an effect a real cold provision at this same `majorVersion`/`enabled` combination would
    // never have touched.
    const realtimeConsumesJwks =
      input.setup.majorVersion >= 15 && input.setup.config.realtime.enabled;
    const jwks = realtimeConsumesJwks ? yield* input.setup.jwks : "";
    return Option.some({
      postgresImage: input.image,
      majorVersion: input.db.major_version,
      jwtSecret: input.jwtSecret,
      jwtExpiry: input.jwtExpiry,
      // The EFFECTIVE value, not the raw input: `legacyBuildShadowPostgresContainerSpec`
      // (`postgres.service.ts`) falls back to the embedded default when unset, so hashing `""`
      // would fail to re-key if that security-sensitive default ever rotates between CLI
      // releases (review: depthfirst on #6184).
      rootKey: input.rootKey ?? LEGACY_POSTGRES_DEFAULT_ROOT_KEY,
      dbPassword: input.password,
      dbSettings: input.db.settings,
      storageTargetMigration: input.setup.storageTargetMigration,
      autoExposeNewTables: input.setup.apiAutoExposeNewTables,
      webhooksEnabled: legacyEffectiveShadowWebhooksEnabled(
        opts.webhooks,
        input.setup.webhooksEnabled,
      ),
      rolesSql,
      vault: input.setup.vault,
      jwks,
      services: {
        realtime: {
          enabled: input.setup.config.realtime.enabled,
          image: resolveJobImage(legacyResolvePinnedImage("realtime", "realtime", overrides)),
        },
        storage: {
          enabled: input.setup.config.storage.enabled,
          image: resolveJobImage(legacyResolvePinnedImage("storage", "storage", overrides)),
        },
        auth: {
          enabled: input.setup.config.auth.enabled,
          image: resolveJobImage(legacyResolvePinnedImage("gotrue", "auth", overrides)),
        },
      },
    } satisfies LegacyShadowCacheKeyInputs);
  });

// ---------------------------------------------------------------------------
// The tar artifact
// ---------------------------------------------------------------------------

/** Filename prefix shared by every key's snapshot — the handle the retention sweep enumerates by. */
const LEGACY_SHADOW_BASELINE_TAR_PREFIX = "shadow-baseline-";

const LEGACY_SHADOW_BASELINE_TAR_SUFFIX = ".tar";

/** Cap on published tars in the global cache (~90MB each → ~720MB). */
export const LEGACY_SHADOW_BASELINE_KEEP = 8;

/** Drop published tars whose mtime is older than this (warm hits refresh mtime). */
export const LEGACY_SHADOW_BASELINE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * `shadow-baseline-<key>.tar` under `${SUPABASE_HOME}/cache/shadow-baseline/` — one ~90MB file
 * per settings key, shared across worktrees.
 */
export function legacyShadowBaselineTarFileName(key: string): string {
  return `${LEGACY_SHADOW_BASELINE_TAR_PREFIX}${key}${LEGACY_SHADOW_BASELINE_TAR_SUFFIX}`;
}

/** This key's absolute snapshot path in the global cache directory. */
export function legacyShadowBaselineTarPath(path: Path.Path, key: string): string {
  return path.join(legacyShadowBaselineCacheDir(path), legacyShadowBaselineTarFileName(key));
}

/**
 * Whether `fileName` is a published baseline snapshot (`shadow-baseline-<key>.tar`). Pure and
 * deliberately conservative: only this module's own prefix AND suffix, so partials
 * (`…tar.<pid>.partial`) and any unrelated file in the cache dir are never eviction candidates.
 */
export function legacyIsShadowBaselineTar(fileName: string): boolean {
  return (
    fileName.startsWith(LEGACY_SHADOW_BASELINE_TAR_PREFIX) &&
    fileName.endsWith(LEGACY_SHADOW_BASELINE_TAR_SUFFIX) &&
    fileName.length ===
      LEGACY_SHADOW_BASELINE_TAR_PREFIX.length + 16 + LEGACY_SHADOW_BASELINE_TAR_SUFFIX.length &&
    /^shadow-baseline-[0-9a-f]{16}\.tar$/u.test(fileName)
  );
}

/** One published tar as the LRU/TTL rule sees it — name + mtime, no filesystem. */
export interface LegacyShadowBaselineTarEntry {
  readonly fileName: string;
  readonly mtimeMs: number;
}

export interface LegacyShadowBaselineRetentionOpts {
  readonly keep?: number;
  readonly maxAgeMs?: number;
}

/**
 * Pure LRU + age eviction: drop every published tar older than `maxAgeMs`, then among the
 * survivors keep the newest `keep` by mtime. Never returns non-tar names (catalogs, partials).
 * Unit-testable without a filesystem.
 */
export function legacyShadowBaselineTarsToEvict(
  entries: ReadonlyArray<LegacyShadowBaselineTarEntry>,
  now: number,
  opts: LegacyShadowBaselineRetentionOpts = {},
): ReadonlyArray<string> {
  const keep = opts.keep ?? LEGACY_SHADOW_BASELINE_KEEP;
  const maxAgeMs = opts.maxAgeMs ?? LEGACY_SHADOW_BASELINE_MAX_AGE_MS;
  const candidates = entries.filter((entry) => legacyIsShadowBaselineTar(entry.fileName));
  const aged = new Set(
    candidates.filter((entry) => now - entry.mtimeMs > maxAgeMs).map((entry) => entry.fileName),
  );
  const newestFirst = candidates
    .filter((entry) => !aged.has(entry.fileName))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const overCap = newestFirst.slice(keep).map((entry) => entry.fileName);
  return [...aged, ...overCap];
}

/** Best-effort removal — a leftover tar only ever costs disk, never correctness. */
export const legacyForgetShadowBaselineTar = (
  fs: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<void> => fs.remove(filePath).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Whether `fileName` is one of {@link legacyExportPgDataTar}'s in-flight temp files
 * (`shadow-baseline-<key>.tar.<pid>.partial`). Pure name check only — whether it is ABANDONED
 * (crashed/SIGKILLed writer, whose `Effect.onError` cleanup never ran) is an mtime question the
 * sweep answers separately, so a concurrent writer's live temp file is never a candidate by name
 * alone.
 */
export function legacyIsShadowBaselinePartial(fileName: string): boolean {
  return /^shadow-baseline-[0-9a-f]{16}\.tar\.\d+\.partial$/u.test(fileName);
}

/**
 * A partial older than this is abandoned: the export itself streams ~90MB in seconds, so an
 * hour-old temp file's writer is long gone. Deliberately enormous relative to a real export so a
 * slow disk can never get a LIVE temp file swept out from under its writer.
 */
const LEGACY_SHADOW_PARTIAL_ABANDON_MS = 60 * 60 * 1000;

/**
 * Removes abandoned `.partial` temp files (see {@link legacyIsShadowBaselinePartial}) — the one
 * artifact a SIGKILLed/crashed cold export leaves behind that nothing else ever cleans: later
 * runs use their own pid in the temp name, and the tar retention sweep deliberately ignores
 * `.partial` names (review: Codex on #6184). Runs before every cold export and on warm hits (so
 * orphans cannot accumulate once every later run goes warm) — best-effort throughout.
 */
const legacySweepAbandonedShadowBaselinePartials = (
  input: LegacyBaselineCacheFiles,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const cacheDir = legacyShadowBaselineCacheDir(input.path);
    const entries = yield* input.fs
      .readDirectory(cacheDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(
      entries.filter(legacyIsShadowBaselinePartial),
      (entry) =>
        Effect.gen(function* () {
          const filePath = input.path.join(cacheDir, entry);
          const info = yield* input.fs.stat(filePath);
          const mtime = Option.getOrUndefined(info.mtime);
          if (mtime !== undefined && now - mtime.getTime() > LEGACY_SHADOW_PARTIAL_ABANDON_MS) {
            yield* legacyForgetShadowBaselineTar(input.fs, filePath);
          }
        }).pipe(Effect.orElseSucceed(() => undefined)),
      { discard: true },
    );
  });

/**
 * Applies the global-cache LRU + TTL retention rule (see {@link legacyShadowBaselineTarsToEvict}).
 * Best-effort throughout — a snapshot that cannot be swept costs ~90MB of disk, so it must never
 * fail the export or warm hit that just succeeded.
 */
const legacySweepShadowBaselineRetention = (input: LegacyBaselineCacheFiles): Effect.Effect<void> =>
  Effect.gen(function* () {
    const cacheDir = legacyShadowBaselineCacheDir(input.path);
    const names = yield* input.fs
      .readDirectory(cacheDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const now = yield* Clock.currentTimeMillis;
    const entries: Array<LegacyShadowBaselineTarEntry> = [];
    for (const fileName of names) {
      if (!legacyIsShadowBaselineTar(fileName)) continue;
      const info = yield* input.fs
        .stat(input.path.join(cacheDir, fileName))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (info === undefined) continue;
      const mtime = Option.getOrUndefined(info.mtime);
      if (mtime === undefined) continue;
      entries.push({ fileName, mtimeMs: mtime.getTime() });
    }
    yield* Effect.forEach(
      legacyShadowBaselineTarsToEvict(entries, now),
      (fileName) => legacyForgetShadowBaselineTar(input.fs, input.path.join(cacheDir, fileName)),
      { discard: true },
    );
  });

/** Refresh mtime on a warm hit so frequently used keys survive LRU/TTL. Best-effort. */
const legacyTouchShadowBaselineTar = (
  fs: FileSystem.FileSystem,
  tarPath: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = new Date(yield* Clock.currentTimeMillis);
    yield* fs.utimes(tarPath, now, now);
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * The bookkeeping every warm hit runs before restoring: refresh the tar's mtime (so frequently
 * used keys survive LRU/TTL), then sweep abandoned partials and over-cap/aged tars — a killed
 * concurrent writer's leftover would otherwise persist indefinitely once every later run goes
 * warm, since the cold export's own sweep never runs again (review: Codex on #6184). Best-effort
 * and cheap throughout. Shared by the shadow acquire below and `main-db-baseline.ts`.
 */
export const legacyRefreshShadowBaselineOnWarmHit = (
  input: LegacyBaselineCacheFiles,
  tarPath: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* legacyTouchShadowBaselineTar(input.fs, tarPath);
    yield* legacySweepAbandonedShadowBaselinePartials(input);
    yield* legacySweepShadowBaselineRetention(input);
  });

// ---------------------------------------------------------------------------
// Container primitives the cache adds on top of `shadow-database.ts`
// ---------------------------------------------------------------------------

/**
 * `docker <verb> <id>`, resolving to {@link LegacyShadowCacheUnavailable} on anything but a clean
 * exit. Both verbs this is used for (`stop`, `start`) are steps the export cannot proceed without,
 * so a non-zero exit is an anomaly rather than something to tolerate.
 */
const legacyShadowContainerVerb = (
  spawner: Spawner,
  verb: "start" | "stop",
  containerId: string,
): Effect.Effect<void, LegacyShadowCacheUnavailable> =>
  containerCliExitCode(spawner, [verb, containerId], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).pipe(
    Effect.mapError((cause) =>
      legacyShadowCacheUnavailable(
        `failed to ${verb} shadow container: ${legacyDescribeContainerCliFailure(cause)}`,
      ),
    ),
    Effect.flatMap((exitCode) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail(legacyShadowCacheUnavailable(`docker ${verb} exited ${exitCode}`)),
    ),
  );

/** The shadow's own connect target, shared by the readiness waits on both paths. */
const legacyShadowConnConfig = <E>(input: LegacyShadowSetupInput<E>): LegacyPgConnInput => ({
  host: input.hostname,
  port: input.shadowPort,
  user: "postgres",
  password: input.password,
  database: "postgres",
});

/**
 * `legacyWaitForShadowReady` self-instruments (`ready-attempt`/`ready-wait`, `health-check.ts`)
 * whenever `SUPABASE_SHADOW_DEBUG` is on, so neither call site here needs an extra timing wrapper.
 */
const legacyAwaitClusterReady = (
  spawner: Spawner,
  containerId: string,
  args: {
    readonly connConfig: LegacyPgConnInput;
    readonly healthTimeoutSeconds: number;
    readonly image: string;
  },
  what: string,
): Effect.Effect<void, LegacyShadowCacheUnavailable, LegacyDbConnection> =>
  legacyWaitForShadowReady(spawner, containerId, args.connConfig, {
    timeoutSeconds: args.healthTimeoutSeconds,
    image: args.image,
  }).pipe(
    Effect.mapError((cause) =>
      legacyShadowCacheUnavailable(`${what} never became ready: ${cause.message}`),
    ),
  );

const legacyAwaitShadowReady = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
  containerId: string,
  what: string,
): Effect.Effect<void, LegacyShadowCacheUnavailable, LegacyDbConnection> =>
  legacyAwaitClusterReady(
    spawner,
    containerId,
    {
      connConfig: legacyShadowConnConfig(input),
      healthTimeoutSeconds: input.healthTimeoutSeconds,
      image: input.image,
    },
    what,
  );

// ---------------------------------------------------------------------------
// Cold export
// ---------------------------------------------------------------------------

/**
 * Serializes same-process cold exports. Two shadows provisioned concurrently in one process
 * (pg-delta next's plan shadows — `legacy-pgdelta-next-shadow.layer.ts`'s `provisionPlan`) can
 * both reach the export step, and with an equal key (the declarative and migrations shadows
 * hash identically whenever their effective webhooks booleans agree) they would race on the
 * SAME `<tar>.<pid>.partial` temp path — `legacyExportPgDataTar` scopes its temp name by pid
 * alone, so the second writer's pre-clean unlinks the first's live temp file, and the first's
 * rename would then publish the second's half-written bytes under the final name. One permit
 * makes that interleaving impossible; cross-PROCESS writers were never affected (distinct
 * pids). Exports run only on the cold path and take seconds, so the serialization is invisible
 * outside a double-cold first run.
 */
const legacyShadowExportMutex = Semaphore.makeUnsafe(1);

/**
 * Ensures the tar's global cache directory exists, delegates the actual export to
 * {@link legacyExportPgDataTar} (`pgdata-snapshot.ts` — see that function's own doc comment for
 * the atomic-publish mechanics), then applies the LRU + TTL retention rule. Runs under
 * {@link legacyShadowExportMutex}.
 *
 * `skipIfPublished` dedupes same-key sibling exports: when the tar was ABSENT at acquire time
 * (the `!cached` cold path), one published while this fiber waited on the permit is a sibling's
 * snapshot of this same baseline, so re-exporting would only re-move ~90MB to replace equivalent
 * bytes. It must be `false` on the warm-fallback cold path, where a tar deliberately RETAINED
 * despite an unusable restore (see `LegacyShadowCacheUnavailable.tarSuspect`) is sitting at this
 * exact path waiting to be atomically replaced — skipping there would leave a genuinely corrupt
 * tar in place forever, failing every later warm restore into another cold provision (review:
 * Codex on #6215).
 */
const legacyWriteShadowBaselineTar = (
  spawner: Spawner,
  input: LegacyBaselineCacheFiles,
  tarPath: string,
  containerId: string,
  skipIfPublished: boolean,
): Effect.Effect<void, LegacyShadowCacheUnavailable> =>
  legacyShadowExportMutex.withPermit(
    Effect.gen(function* () {
      if (skipIfPublished) {
        const published = yield* input.fs.exists(tarPath).pipe(Effect.orElseSucceed(() => false));
        if (published) return;
      }
      const cacheDir = legacyShadowBaselineCacheDir(input.path);
      yield* input.fs
        .makeDirectory(cacheDir, { recursive: true, mode: 0o700 })
        .pipe(
          Effect.mapError((cause) =>
            legacyShadowCacheUnavailable(`failed to create ${cacheDir}: ${cause.message}`),
          ),
        );
      yield* legacySweepAbandonedShadowBaselinePartials(input);
      yield* legacyExportPgDataTar(spawner, containerId, input.fs, tarPath).pipe(
        Effect.mapError((cause: LegacyPgDataSnapshotUnavailable) =>
          legacyShadowCacheUnavailable(cause.reason),
        ),
      );
      yield* legacySweepShadowBaselineRetention(input);
    }),
  );

/**
 * The one failure {@link legacyExportBaselineSnapshot} does NOT degrade: the cluster did not come
 * back up after its snapshot. Every caller re-maps it into its OWN error vocabulary
 * (`LegacyShadowDbError` for the shadow, `LegacyDbSetupError` for the local `db` container) rather
 * than letting this module pick one for both, so this class never reaches a command's own error
 * rendering — its declaration exists because every error type in this codebase carries one, and
 * mirrors what both of those mappings resolve to (`reason: "docker_daemon"`).
 */
export class LegacyBaselineSnapshotRevivalFailure extends Data.TaggedError(
  "LegacyBaselineSnapshotRevivalFailure",
)<{
  readonly reason: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.dockerNotRunning, fingerprint_suffix: "docker_not_running" };
  }
}

/**
 * The cold path's snapshot step, run at the baseline/migrations seam — after
 * `legacySetupDatabase` and strictly before `contrib_regression` or any user migration (the
 * shadow) / `MigrateAndSeed` (the local `db` container), with no session open against the cluster
 * ({@link LegacyShadowBaselineState.snapshotBaseline}).
 *
 * `docker stop` -> export -> `docker start` -> readiness wait. The container is stopped because a
 * live Postgres's PGDATA is not a coherent thing to copy; the stop is fast (~1s) because the
 * entrypoint `exec`s Postgres, so PID 1 receives the SIGTERM instead of `sh` swallowing it and
 * burning the full 10s grace period — and because a session left open would hold SIGTERM's smart
 * shutdown until the grace period expires, forcing a SIGKILL and an unclean snapshot.
 *
 * Two failure classes, deliberately NOT one broad catch: a stop/export failure only means this
 * run stays uncached — it warns and the run continues. A restart/readiness failure is the RUN'S
 * problem: the caller is about to reconnect to the cluster's published port, and reporting success
 * over a dead container would make that connect a blind dial — which can even reach a DIFFERENT
 * Postgres that claimed the port while the container was down (matching default credentials are
 * common locally), applying the template + migrations to the wrong database. So the restart runs
 * whether the export succeeded or not (`docker start` on an already-running container — e.g. when
 * the stop itself failed — is a no-op success), and its failure PROPAGATES as a
 * {@link LegacyBaselineSnapshotRevivalFailure} instead of degrading (review: Codex on #6184).
 *
 * The readiness gate is {@link legacyWaitForShadowReady} (a direct connect probe) for BOTH
 * clusters, never the Docker health gate the long-running `db` container's own bring-up uses: that
 * healthcheck has a 10-second interval and no start period, so waiting on it here would add ~6.5s
 * to every cold run for a verdict Postgres can already give.
 */
export const legacyExportBaselineSnapshot = (
  spawner: Spawner,
  input: LegacyBaselineCacheFiles,
  args: {
    readonly containerId: string;
    readonly tarPath: string;
    /** The resolved cache key — stamped into PGDATA right before the copy-out. */
    readonly key: string;
    readonly skipIfPublished: boolean;
    /** The cluster's own host-facing connect target, for the post-restart readiness probe. */
    readonly connConfig: LegacyPgConnInput;
    readonly healthTimeoutSeconds: number;
    /** The cluster's resolved image, named in the readiness gate's exec-format recovery hint. */
    readonly image: string;
    /** How the cache names itself in the degraded-publish warning (`shadow`/`database`). */
    readonly warnLabel: string;
    /** How the cluster names itself in a revival failure (`shadow database`/`local database`). */
    readonly clusterLabel: string;
    /** How the readiness gate names the restarted cluster (`re-started shadow`/`re-started database`). */
    readonly readyLabel: string;
  },
): Effect.Effect<void, LegacyBaselineSnapshotRevivalFailure, Output | LegacyDbConnection> =>
  legacyTimeShadowPhase(
    "baseline-export",
    Effect.gen(function* () {
      // Cache-degradable phase: stop + export. A failure here (including a failed stop, after
      // which the container is simply still up) only costs this run its snapshot.
      const exported = yield* Effect.result(
        Effect.gen(function* () {
          yield* legacyShadowContainerVerb(spawner, "stop", args.containerId);
          // The stamp is what makes the published tar mean "the baseline THIS key promises"
          // rather than "some PostgreSQL cluster". Two things give it that meaning. Its POSITION
          // in the sequence: this whole step runs from the cold state's `snapshotBaseline`,
          // which every provisioning pipeline invokes strictly after the platform baseline is in
          // place, and the stamp is the last mutation before the copy-out — so a future
          // regression that snapshots EARLIER cannot produce a marked tar, it just stays
          // uncached instead of silently publishing a bare cluster under a baseline key. And its
          // CONTENT: `key` itself, which the warm restore compares against the key it resolved
          // this run, so a valid snapshot of a DIFFERENT key that was copied over this filename
          // is rejected too (review: Codex on #6184).
          yield* legacyStampPgDataBaselineMarker(spawner, args.containerId, args.key).pipe(
            Effect.mapError((cause: LegacyPgDataSnapshotUnavailable) =>
              legacyShadowCacheUnavailable(cause.reason),
            ),
          );
          yield* legacyWriteShadowBaselineTar(
            spawner,
            input,
            args.tarPath,
            args.containerId,
            args.skipIfPublished,
          );
        }),
      );
      // Run-critical phase: the cluster must be back up and answering before this step reports
      // success — see this function's own doc comment for why these failures must propagate.
      const revive = Effect.gen(function* () {
        yield* legacyShadowContainerVerb(spawner, "start", args.containerId);
        yield* legacyAwaitClusterReady(spawner, args.containerId, args, args.readyLabel);
      });
      yield* revive.pipe(
        Effect.mapError(
          (cause) =>
            new LegacyBaselineSnapshotRevivalFailure({
              reason: `${args.clusterLabel} did not come back after the baseline snapshot: ${cause.reason}`,
            }),
        ),
      );
      if (Result.isFailure(exported)) {
        const output = yield* Output;
        yield* output.raw(
          `Warning: ${args.warnLabel} baseline not cached: ${exported.failure.reason}\n`,
          "stderr",
        );
      }
    }),
  );

/** The shadow's own binding of {@link legacyExportBaselineSnapshot}, in its error vocabulary. */
const legacyExportShadowBaseline = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
  key: string,
  tarPath: string,
  containerId: string,
  skipIfPublished: boolean,
): Effect.Effect<void, LegacyShadowDbError, Output | LegacyDbConnection> =>
  legacyExportBaselineSnapshot(spawner, input, {
    containerId,
    tarPath,
    key,
    skipIfPublished,
    connConfig: legacyShadowConnConfig(input),
    healthTimeoutSeconds: input.healthTimeoutSeconds,
    image: input.image,
    warnLabel: "shadow",
    clusterLabel: "shadow database",
    readyLabel: "re-started shadow",
  }).pipe(
    Effect.mapError(
      (cause) => new LegacyShadowDbError({ message: cause.reason, reason: "docker_daemon" }),
    ),
  );

// ---------------------------------------------------------------------------
// Acquire / release
// ---------------------------------------------------------------------------

/**
 * Per-invocation cache controls a CALLER passes (as opposed to the user-level
 * {@link LEGACY_SHADOW_CACHE_ENV} env gate). `bypassCache` is `db schema declarative sync
 * --no-cache`'s hook: that flag documents "force fresh shadow database setup", so a run carrying
 * it must neither restore an existing snapshot nor publish a new one — exactly the uncached
 * lifecycle, regardless of the env gate (review: Codex on #6184).
 *
 * `webhooks` is the same policy the caller will pass to `legacySetupDatabase` /
 * `legacySetupShadowDatabase` / `legacyMigrate*ShadowDatabase`. Defaults to `"config"`
 * (follow `setup.webhooksEnabled`), matching {@link LegacySetupDatabaseOptions}. Hashed as
 * the effective boolean so a forced-on legacy migrate snapshot cannot warm-restore into a
 * next path that follows config, or a declarative shadow that forces webhooks off.
 */
export interface LegacyShadowCacheOpts {
  readonly bypassCache?: boolean;
  readonly webhooks?: LegacySetupDatabaseOptions["webhooks"];
  /**
   * Key inputs a caller already resolved via {@link legacyPeekShadowBaseline}, so
   * {@link legacyAcquireShadowDatabase} does not resolve them a second time. Resolution is not
   * idempotent-cheap: it can include a live JWKS discovery request (realtime on PG15+), so a
   * peek-then-acquire caller passing this through halves that traffic. MUST have been computed
   * from the same `input`/`opts` pair, or the acquire keys against the wrong snapshot.
   */
  readonly precomputedKeyInputs?: LegacyShadowCacheKeyInputs;
}

/** What {@link legacyPeekShadowBaseline} learned about a would-be acquire, without provisioning anything. */
export type LegacyShadowBaselinePeek =
  /** The cache cannot apply: bypassed, env-disabled, or key-ineligible (PG<=14, OrioleDB, unreadable roles.sql). */
  | { readonly state: "uncachable" }
  | {
      readonly state: "cold" | "warm";
      readonly key: string;
      /** Pass back via {@link LegacyShadowCacheOpts.precomputedKeyInputs} to skip re-resolution. */
      readonly keyInputs: LegacyShadowCacheKeyInputs;
    };

/**
 * Answers "what would {@link legacyAcquireShadowDatabase} do for this input right now?" without
 * creating a container: `warm` (a snapshot for this key is published), `cold` (cache-enabled but
 * no snapshot yet), or `uncachable`. Callers use it to CHOOSE an orchestration (pg-delta next's
 * plan provisioning picks parallel / baseline-handoff / sequential — see
 * `legacy-pgdelta-next-shadow.plan.ts`), never to skip the acquire's own re-checks: the answer
 * can go stale between peek and acquire (another process publishes or evicts the tar), and the
 * acquire re-deciding on current state is what keeps that race merely suboptimal rather than
 * incorrect.
 *
 * The error channel is the key resolution's own `E` (a JWKS resolution failure) — same rationale
 * as {@link legacyAcquireShadowDatabase}: a real cold provision at this input would have failed
 * the same way, so it must not be folded into `uncachable`.
 */
export const legacyPeekShadowBaseline = <E>(
  input: LegacyBaselineCacheInput<E>,
  opts: LegacyShadowCacheOpts = {},
): Effect.Effect<LegacyShadowBaselinePeek, E> =>
  Effect.gen(function* () {
    if (
      opts.bypassCache === true ||
      !legacyShadowCacheEnabled(process.env, input.setup.projectEnvValues)
    ) {
      return { state: "uncachable" } as const;
    }
    const keyInputs = yield* legacyResolveShadowCacheKeyInputs(input, opts);
    if (Option.isNone(keyInputs)) return { state: "uncachable" } as const;
    const key = legacyShadowCacheKey(keyInputs.value);
    const tarPath = legacyShadowBaselineTarPath(input.path, key);
    const cached = yield* input.fs.exists(tarPath).pipe(Effect.orElseSucceed(() => false));
    return {
      state: cached ? ("warm" as const) : ("cold" as const),
      key,
      keyInputs: keyInputs.value,
    };
  });

/**
 * What `Effect.acquireUseRelease`'s `acquire` hands the `use` phase: the container, whether its
 * cluster already carries the platform baseline, and the snapshot step to run once a fresh
 * baseline is in place. Release needs nothing extra — every shadow this module hands out is
 * removed the same way an uncached one is.
 */
export type LegacyShadowAcquiredHandle = LegacyShadowBaselineState & {
  readonly containerId: string;
};

/** A throwaway shadow with no snapshot step — the cache-off path. */
const legacyUncachedShadow = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
): Effect.Effect<LegacyShadowAcquiredHandle, LegacyShadowDbError> =>
  legacyCreateShadowDatabase(spawner, input).pipe(
    Effect.map(({ containerId }) => ({ containerId, _tag: "uncached" as const })),
  );

/**
 * A cold, cache-enabled shadow: today's container plus the export step at the baseline seam.
 *
 * `autoRemove: false` is the one and only container-shape difference the cache introduces, and it
 * is forced: the export has to `docker stop` the container and `docker start` it again, and Docker
 * destroys an `--rm` container the moment it exits. Release still removes it with `docker rm -f
 * -v`, so the container's lifetime is unchanged — see
 * {@link LegacyCreateShadowDatabaseInput.autoRemove}.
 *
 * `skipIfPublished` MUST reflect whether the tar was absent when this cold acquisition began —
 * see {@link legacyWriteShadowBaselineTar} for what each value means and why the warm-fallback
 * caller must pass `false`.
 */
const legacyColdCachedShadow = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
  key: string,
  tarPath: string,
  skipIfPublished: boolean,
  rolesSql: string,
): Effect.Effect<LegacyShadowAcquiredHandle, LegacyShadowDbError> =>
  legacyCreateShadowDatabase(spawner, { ...input, autoRemove: false }).pipe(
    Effect.map(({ containerId }) => ({
      containerId,
      _tag: "cold" as const,
      rolesSql,
      snapshotBaseline: legacyExportShadowBaseline(
        spawner,
        input,
        key,
        tarPath,
        containerId,
        skipIfPublished,
      ),
    })),
  );

/** A cache key as {@link legacyShadowCacheKey} produces it — 16 hex chars, nothing else. */
const LEGACY_SHADOW_CACHE_KEY_PATTERN = /^[0-9a-f]{16}$/u;

/**
 * The warm-path warning's wording for a rejected snapshot. Names WHICH of the two content failures
 * happened, because they mean different things to whoever reads the line: a missing entry is a
 * broken or hand-placed artifact, while a wrong key is a real snapshot of another configuration
 * sitting under this one's filename (a copied cache directory, a renamed file) — and only the
 * misnamed copy is being discarded, not that other key's own tar.
 *
 * The marker's own bytes are NOT echoed verbatim: they come from a file this run did not write,
 * capped at a KiB but otherwise arbitrary, and stderr is not the place to render them. Only a token
 * that is shaped like a cache key is shown.
 */
const legacyDescribeShadowArchiveProblem = (problem: LegacyPgDataArchiveProblem): string => {
  if (problem._tag === "missing-entries") {
    return `snapshot has no ${problem.entries.join(" or ")} entry`;
  }
  const found =
    problem.found !== undefined && LEGACY_SHADOW_CACHE_KEY_PATTERN.test(problem.found)
      ? `key ${problem.found}`
      : "an unreadable key";
  return `snapshot is stamped with ${found}, not ${problem.expected}`;
};

/**
 * The warm path proper: verify the snapshot tar really carries a baselined cluster, create the
 * shadow with it unpacked into it before it starts ({@link LegacyCreateShadowDatabaseInput.restoreArchive}),
 * then wait for the restored Postgres. Every failure resolves to
 * {@link LegacyShadowCacheUnavailable}, which the caller turns into the escape hatch.
 *
 * The readiness failure removes the container here rather than leaving it to the caller, because
 * the caller's fallback creates a REPLACEMENT container and the suspect one must be gone by then
 * (it holds the shadow's published port).
 *
 * The readiness wait is explicitly `Effect.interruptible`: this whole function runs inside
 * `Effect.acquireUseRelease`'s uninterruptible `acquire` ({@link legacyWithShadowDatabase}), and
 * while the restore itself is short (~2s of `docker create` + `docker cp -`), a restored container
 * that starts but never accepts connections would otherwise pin a Ctrl-C for the full
 * `healthTimeoutSeconds` budget — exactly the swallowed-SIGINT shape `legacyPrepareShadowSource`'s
 * own doc comment (`legacy-shadow-source.ts`) was restructured to avoid. `Effect.onInterrupt`
 * removes the container on that path, so re-enabling interruption cannot leak it (review: Codex
 * on #6184).
 */
const legacyWarmShadow = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
  key: string,
  tarPath: string,
): Effect.Effect<
  LegacyShadowAcquiredHandle,
  LegacyShadowCacheUnavailable,
  Output | LegacyDbConnection
> =>
  Effect.gen(function* () {
    // An archive that unpacks cleanly but carries the wrong thing is the ONE corruption the restore
    // itself cannot report: `docker cp -` extracts whatever it is given, the entrypoint skips
    // `initdb` (or runs one over an empty PGDATA), readiness passes, and this function would hand
    // back `baselinePresent: true` for a cluster that never saw `legacySetupDatabase` — the caller
    // then skips it too and diffs against a BARE database, silently producing wrong SQL. The same
    // shape hides a second lie: a fully baselined snapshot of ANOTHER key, copied over this key's
    // filename, restores just as cleanly while carrying different roles/vault values/service
    // schema. So the tar's own headers are scanned BEFORE anything is created (locally, no Docker)
    // for the cluster file, for the baseline marker this module stamps immediately before every
    // export, AND for that marker's key — see {@link legacyValidatePgDataArchive}. A read failure
    // is infra and leaves the tar in place; either verdict implicates its CONTENTS (review: Codex
    // on #6184).
    const problem = yield* legacyValidatePgDataArchive(input.fs, tarPath, key).pipe(
      Effect.mapError((cause) => legacyShadowCacheUnavailable(cause.reason)),
    );
    if (Option.isSome(problem)) {
      return yield* Effect.fail(
        legacyShadowCacheUnavailable(legacyDescribeShadowArchiveProblem(problem.value), {
          tarSuspect: true,
        }),
      );
    }
    const { containerId } = yield* legacyTimeShadowPhase(
      "baseline-restore",
      legacyCreateShadowDatabase(spawner, {
        ...input,
        restoreArchive: legacyPgDataRestoreArchive(input.fs, tarPath),
      }),
    ).pipe(
      Effect.mapError((cause) =>
        legacyShadowCacheUnavailable(`failed to restore shadow baseline: ${cause.message}`),
      ),
    );
    yield* legacyAwaitShadowReady(spawner, input, containerId, "restored shadow").pipe(
      // The ONE failure that implicates the tar's contents: the restored cluster started but
      // never accepted connections — see {@link LegacyShadowCacheUnavailable.tarSuspect}.
      Effect.mapError((cause) => legacyShadowCacheUnavailable(cause.reason, { tarSuspect: true })),
      Effect.tapError(() => legacyRemoveShadowDatabase(spawner, containerId)),
      Effect.onInterrupt(() => legacyRemoveShadowDatabase(spawner, containerId)),
      Effect.interruptible,
    );
    return { containerId, _tag: "warm" } satisfies LegacyShadowAcquiredHandle;
  });

/**
 * `Effect.acquireUseRelease`'s `acquire` for every shadow-provisioning call site that runs the
 * platform baseline (`db diff`'s migra/pg-delta branch, `db pull`'s migration diff,
 * `legacy-pgdelta.cache.ts`'s catalog export, and pg-delta next's scoped shadows) — see
 * {@link legacyWithShadowDatabase} for the acquire/use/release wrapper, and
 * `legacy-pgdelta-next-shadow.layer.ts` for the scoped `acquireRelease` form next uses so the
 * container outlives provision (the engine keeps using the URL after this returns).
 *
 * With {@link LEGACY_SHADOW_CACHE_ENV} set to a falsey value this IS `legacyCreateShadowDatabase`,
 * byte for byte. Otherwise it resolves the cache key and either restores this key's snapshot into
 * a fresh container (warm) or creates one and arranges for its baseline to be exported (cold).
 * Either way the container itself is created identically to an uncached one.
 *
 * Runs inside `acquireUseRelease`'s uninterruptible `acquire`, same as
 * `legacyCreateShadowDatabase` — a warm restore adds ~2s of uninterruptible work (a `docker cp -`);
 * its readiness wait re-enables interruption explicitly (see {@link legacyWarmShadow}), and the
 * multi-second baseline/migration sequence stays in the interruptible `use` phase exactly as
 * before.
 *
 * The `E` in the error channel is {@link legacyResolveShadowCacheKeyInputs}'s own JWKS
 * resolution alone (see that function's doc comment): every OTHER failure this function's own
 * body can produce while computing the key or restoring the snapshot is caught and degraded to a
 * cold provision — a genuine JWKS failure is the one case that must reach the caller instead,
 * since a real cold provision at this input would have failed the same way.
 */
export const legacyAcquireShadowDatabase = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
  opts: LegacyShadowCacheOpts = {},
): Effect.Effect<
  LegacyShadowAcquiredHandle,
  LegacyShadowDbError | E,
  Output | LegacyDbConnection
> =>
  Effect.gen(function* () {
    if (
      opts.bypassCache === true ||
      !legacyShadowCacheEnabled(process.env, input.setup.projectEnvValues)
    ) {
      return yield* legacyUncachedShadow(spawner, input);
    }

    // Interruptible: this runs inside `acquireUseRelease`'s uninterruptible `acquire`, but
    // nothing has been acquired yet — and the JWKS effect inside can be a real third-party
    // discovery request, which must not pin a Ctrl-C for its whole duration (review: Codex on
    // #6184). Interruption here simply means no container was ever created, so there is nothing
    // for a finalizer to release. A caller that already peeked passes its resolved inputs
    // through ({@link LegacyShadowCacheOpts.precomputedKeyInputs}) so the JWKS request is not
    // repeated; the tar-existence check below always re-runs on current state.
    const keyInputs =
      opts.precomputedKeyInputs !== undefined
        ? Option.some(opts.precomputedKeyInputs)
        : yield* Effect.interruptible(legacyResolveShadowCacheKeyInputs(input, opts));
    if (Option.isNone(keyInputs)) return yield* legacyUncachedShadow(spawner, input);
    const key = legacyShadowCacheKey(keyInputs.value);
    const tarPath = legacyShadowBaselineTarPath(input.path, key);

    // The exact `roles.sql` bytes this key was computed from — carried into the cold provision so
    // the seed executes them rather than re-reading the file (see
    // {@link LegacyColdBaselineState.rolesSql}).
    const rolesSql = keyInputs.value.rolesSql;

    const cached = yield* input.fs.exists(tarPath).pipe(Effect.orElseSucceed(() => false));
    // The tar is absent at acquire time, so a tar found at export time can only be a
    // same-key sibling's fresh publish — dedupe against it.
    if (!cached) {
      return yield* legacyColdCachedShadow(spawner, input, key, tarPath, true, rolesSql);
    }

    yield* legacyRefreshShadowBaselineOnWarmHit(input, tarPath);

    return yield* legacyWarmShadow(spawner, input, key, tarPath).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const output = yield* Output;
          yield* output.raw(
            `Warning: cached shadow baseline unusable (${cause.reason}); recreating.\n`,
            "stderr",
          );
          // Delete ONLY when the failure implicates the tar's contents (a restored cluster that
          // came up broken) — see {@link LegacyShadowCacheUnavailable.tarSuspect} for why an
          // infra or extraction failure leaves it in place (the cold fallback's own export
          // republishes over a genuinely bad tar anyway).
          if (cause.tarSuspect === true) {
            yield* legacyForgetShadowBaselineTar(input.fs, tarPath);
          }
          // No dedupe on this path: unless it was suspect (deleted above), the unusable tar is
          // still sitting at this exact path, deliberately retained so this fallback's own
          // export atomically REPLACES it — skipping because "a tar exists" would leave a
          // genuinely corrupt one in place forever (review: Codex on #6215).
          return yield* legacyColdCachedShadow(spawner, input, key, tarPath, false, rolesSql);
        }),
      ),
    );
  });

/**
 * The acquire/use/release triple every shadow-provisioning call site that runs the platform
 * baseline uses (`db diff`'s migra/pg-delta branch, `db pull`'s migration diff,
 * `legacy-pgdelta.cache.ts`'s catalog export).
 *
 * `Effect.acquireUseRelease`, NOT a `yield* acquire` followed by a later
 * `.pipe(Effect.ensuring(release))`: the latter leaves a real gap between the shadow's successful
 * creation and the finalizer actually being attached — a fiber interrupt landing between those two
 * statements would skip the release entirely, leaking the live container and leaving the shadow
 * port occupied. `acquireUseRelease` closes that: `acquire` runs inside an `uninterruptibleMask`
 * and the release finalizer is registered in the SAME uninterruptible continuation `acquire`
 * resolves into, matching Go's `defer DockerRemove` immediately after successful creation
 * (review: PRRT_kwDOErm0O86XDr4Y). It does NOT make removal unconditional — see
 * `legacyCreateShadowDatabase`'s own doc comment (`shadow-database.ts`) for the still-present,
 * deliberate-Go-parity leak window when `acquire` itself fails partway through (a `docker create`
 * success followed by a `docker cp`/`docker start` failure).
 *
 * `acquire` is ONLY the container acquisition — NOT the health-wait/migrate/declarative-apply
 * `legacyPrepareShadowSource` performs. Those belong in `use`, where a SIGINT can still interrupt
 * them (matching Go's single cancellable `ctx` threaded through the equivalent calls); passing all
 * of `legacyPrepareShadowSource` as `acquire` made that whole sequence uninterruptible too, since
 * `acquireUseRelease`'s `uninterruptibleMask` has no `restore` around `acquire` — see
 * `legacy-shadow-source.ts`'s own doc comment on `legacyPrepareShadowSource` for the full
 * rationale (review: PRRT_kwDOErm0O86XMrID).
 *
 * `release` is `legacyRemoveShadowDatabase` unconditionally — the shadow baseline cache keeps a
 * file, never a container, so there is nothing here for it to special-case.
 *
 * The handle `use` receives also carries the baseline state `legacyPrepareShadowSource` needs.
 *
 * `E` (also present in `use`'s own `E2`, since every real caller's `use` phase already resolves
 * the same `input.setup.jwks` effect via `legacyMigrateShadowDatabase`/`legacyResolveDbSetupPrelude`)
 * can now ALSO surface straight out of `acquire`: see {@link legacyAcquireShadowDatabase}'s own
 * doc comment for why a JWKS failure discovered while computing the cache key must propagate
 * rather than degrade to an uncached shadow.
 */
export const legacyWithShadowDatabase = <E, A, E2, R2>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
  use: (handle: LegacyShadowAcquiredHandle) => Effect.Effect<A, E2, R2>,
  opts: LegacyShadowCacheOpts = {},
): Effect.Effect<A, E2 | LegacyShadowDbError | E, R2 | Output | LegacyDbConnection> =>
  Effect.acquireUseRelease(legacyAcquireShadowDatabase(spawner, input, opts), use, (handle) =>
    legacyRemoveShadowDatabase(spawner, handle.containerId),
  );
