/**
 * Shadow baseline cache for `db diff`/`db pull`/catalog resolution. Snapshots the platform
 * baseline as a PGDATA tar under `${SUPABASE_HOME}/cache/shadow-baseline/` (keep 3, 2-day TTL).
 * Off unless `SUPABASE_SHADOW_CACHE` is set (viper bool + project dotenv). A cache miss or
 * anomaly never fails the run except when the shadow does not come back after a cold export.
 */

import { createHash } from "node:crypto";

import type { ProjectConfig } from "@supabase/config";
import { Clock, Effect, Option, Predicate, Result, type FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { legacyViperEnvBoolWithProjectFallback } from "../../../shared/legacy/legacy-viper-env.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  containerCliExitCode,
  legacyDescribeContainerCliFailure,
} from "../legacy-container-cli.ts";
import { LegacyDbConnection } from "../legacy-db-connection.service.ts";
import { legacyGetRegistryImageUrl } from "../legacy-docker-registry.ts";
import { legacyShadowBaselineCacheDir } from "../legacy-pgdelta.paths.ts";
import { LEGACY_POSTGRES_DEFAULT_ROOT_KEY } from "../legacy-local-config-values.ts";
import {
  LEGACY_START_ENABLE_DATABASE_WEBHOOKS_SQL,
  LEGACY_START_REVOKE_API_PRIVILEGES_SQL,
  type LegacySetupDatabaseOptions,
  legacyResolveSetupWebhooksEnabled,
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
import {
  legacyCreateShadowDatabase,
  legacyRemoveShadowDatabase,
  legacyShadowConnConfig,
  type LegacyShadowBaselineState,
  LegacyShadowDbError,
  type LegacyShadowSetupInput,
} from "./shadow-database.ts";

type Spawner = ChildProcessSpawner["Service"];

/** `SUPABASE_SHADOW_CACHE` — opt-in gate (viper bool; unset is off). */
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
   * throw away a valid ~15s-to-rebuild baseline on transient Docker failures.
   */
  readonly tarSuspect?: boolean;
}

const legacyShadowCacheUnavailable = (
  reason: string,
  opts: { readonly tarSuspect?: boolean } = {},
): LegacyShadowCacheUnavailable => ({ reason, ...opts });

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/** One of the three PG15+ one-shot migrate jobs, as the cache key sees it. */
export interface LegacyShadowCacheServiceInput {
  readonly enabled: boolean;
  /** Registry-resolved image; hashed only when {@link enabled}. */
  readonly image: string;
}

/**
 * Inputs baked into the shadow cluster. Separate from `legacySetupInputsToken`:
 * that catalog key hashes vault names only and omits job image tags.
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
   * Storage migration pin from `supabase/.temp/storage-migration`. Hashed only when
   * storage is enabled and `majorVersion >= 15`.
   */
  readonly storageTargetMigration: string;
  readonly dbSettings: ProjectConfig["db"]["settings"];
  /**
   * `api.auto_expose_new_tables` as config carries it. Hashed as the effective
   * two-state behavior — see {@link legacyEffectiveShadowApiGrantsKept}.
   */
  readonly autoExposeNewTables: Option.Option<boolean>;
  /**
   * Effective Webhooks/`pg_net` policy `legacySetupDatabase` applies. Legacy
   * migrate forces enabled; next declarative forces disabled; next migrate
   * follows config.
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
 * Digest of CLI-embedded literals baked into the baseline (initdb heredocs, privilege
 * SQL, vault upsert SQL, Realtime seed constants). Lazy: these are compile-time constants.
 * PG<=14 setup SQL is excluded because that major is cache-ineligible.
 */
let legacyShadowBaselineEmbeddedDigestMemo: string | undefined;
const legacyShadowBaselineEmbeddedDigest = (): string =>
  (legacyShadowBaselineEmbeddedDigestMemo ??= createHash("sha256")
    .update(
      [
        LEGACY_START_DB_SCHEMA_SQL,
        LEGACY_START_DB_WEBHOOK_SQL,
        LEGACY_START_DB_SUPABASE_SQL,
        LEGACY_START_REVOKE_API_PRIVILEGES_SQL,
        LEGACY_START_ENABLE_DATABASE_WEBHOOKS_SQL,
        LEGACY_READ_VAULT_KV,
        LEGACY_UPDATE_VAULT_KV,
        LEGACY_CREATE_VAULT_KV,
        LEGACY_REALTIME_TENANT_ID,
        LEGACY_REALTIME_ENCRYPTION_KEY,
        LEGACY_REALTIME_DB_USER,
        LEGACY_START_INTERNAL_DB_NAME,
        String(LEGACY_START_INTERNAL_DB_PORT),
      ].join("\n--8<--\n"),
      "utf8",
    )
    .digest("hex"));

/** JSON with recursively key-sorted objects, so `db.settings`' own property order cannot change the key. */
function legacyCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(legacyCanonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${legacyCanonicalJson(entryValue)}`).join(",")}}`;
}

/**
 * The two-state behavior `legacyApplyApiPrivileges` (`db-setup.ts`) actually derives from
 * `api.auto_expose_new_tables`' tri-state: it returns early ONLY for an explicit `true`, so unset
 * and explicit `false` both exec {@link LEGACY_START_REVOKE_API_PRIVILEGES_SQL} and bake the exact
 * same cluster. Hashing the raw tri-state would split those two into different keys and force a
 * spurious ~90MB re-snapshot for a config edit that changes nothing on disk.
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
  // JSON-encode unrestricted strings so a raw newline cannot forge the next payload line.
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
    `api_grants_kept=${legacyEffectiveShadowApiGrantsKept(inputs.autoExposeNewTables)}`,
    `webhooks_enabled=${inputs.webhooksEnabled}`,
    `baseline_embedded_digest=${legacyShadowBaselineEmbeddedDigest()}`,
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
  // Only resolved vault entries: the upsert skips unresolved secrets.
  for (const secret of inputs.vault
    .filter((secret) => secret.resolved)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    // JSON-encoded tuple, not `name=value`: both halves are unrestricted strings, so a bare
    // `=` join would let (`a=b`, `c`) and (`a`, `b=c`) collide — and a value containing a
    // newline could forge a whole extra payload line.
    lines.push(`vault=${JSON.stringify([secret.name, secret.value])}`);
  }
  // Last, raw (it can contain anything, including newlines) — mirroring `setupInputsToken`,
  // which also appends `roles.sql` verbatim at the end of its own payload.
  const payload = `${lines.join("\n")}\nroles_sql=\n${inputs.rolesSql}`;
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

/**
 * Resolves {@link LegacyShadowCacheKeyInputs} from the same run input the shadow container
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
  input: LegacyShadowSetupInput<E>,
  opts: LegacyShadowCacheOpts = {},
): Effect.Effect<Option.Option<LegacyShadowCacheKeyInputs>, E> =>
  Effect.gen(function* () {
    // OrioleDB keeps cluster state in S3, so a PGDATA tar is not a coherent snapshot.
    const orioledbVersion = input.experimental.orioledb_version;
    if (orioledbVersion !== undefined && orioledbVersion.length > 0) return Option.none();

    // PG<=14 applies `ALTER ROLE … SET` on the setup session; a snapshot reconnect would
    // observe those defaults and change migration resolution.
    if (input.setup.majorVersion <= 14) return Option.none();

    const rolesPath = input.path.join(input.workdir, "supabase", "roles.sql");
    const rolesSql = yield* input.fs
      .readFileString(rolesPath)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          Predicate.isTagged(error.reason, "NotFound")
            ? Effect.succeed("")
            : Effect.succeed(undefined),
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
      // releases.
      rootKey: input.rootKey ?? LEGACY_POSTGRES_DEFAULT_ROOT_KEY,
      dbPassword: input.password,
      dbSettings: input.db.settings,
      storageTargetMigration: input.setup.storageTargetMigration,
      autoExposeNewTables: input.setup.apiAutoExposeNewTables,
      webhooksEnabled: legacyResolveSetupWebhooksEnabled(
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

/** Cap on published tars in the global cache (~90MB each). */
export const LEGACY_SHADOW_BASELINE_KEEP = 3;

/** Drop unused published tars older than 2 days (warm hits refresh mtime). */
export const LEGACY_SHADOW_BASELINE_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * `shadow-baseline-<key>.tar` under `${SUPABASE_HOME}/cache/shadow-baseline/` — one ~90MB file
 * per settings key, shared across worktrees.
 */
export function legacyShadowBaselineTarFileName(key: string): string {
  return `${LEGACY_SHADOW_BASELINE_TAR_PREFIX}${key}${LEGACY_SHADOW_BASELINE_TAR_SUFFIX}`;
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
  /** Never evict this published tar, even if it is older than the TTL or over the cap. */
  readonly retainFileName?: string;
}

/**
 * Pure LRU + age eviction: drop every published tar older than `maxAgeMs`, then among the
 * survivors keep the newest `keep` by mtime. The current run's tar is never evicted.
 */
export function legacyShadowBaselineTarsToEvict(
  entries: ReadonlyArray<LegacyShadowBaselineTarEntry>,
  now: number,
  opts: LegacyShadowBaselineRetentionOpts = {},
): ReadonlyArray<string> {
  const keep = opts.keep ?? LEGACY_SHADOW_BASELINE_KEEP;
  const maxAgeMs = opts.maxAgeMs ?? LEGACY_SHADOW_BASELINE_MAX_AGE_MS;
  const retain = opts.retainFileName;
  const candidates = entries.filter(
    (entry) => legacyIsShadowBaselineTar(entry.fileName) && entry.fileName !== retain,
  );
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
const legacyForgetShadowBaselineTar = (
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

/** A partial older than 5 minutes is abandoned; a live export finishes in seconds. */
const LEGACY_SHADOW_PARTIAL_ABANDON_MS = 5 * 60 * 1000;

/**
 * Removes abandoned `.partial` temp files (see {@link legacyIsShadowBaselinePartial}) — the one
 * artifact a SIGKILLed/crashed cold export leaves behind that nothing else ever cleans: later
 * runs use their own pid in the temp name, and the tar retention sweep deliberately ignores
 * `.partial` names — best-effort throughout.
 */
const legacySweepAbandonedShadowBaselinePartials = <E>(
  input: LegacyShadowSetupInput<E>,
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
const legacySweepShadowBaselineRetention = <E>(
  input: LegacyShadowSetupInput<E>,
  retainFileName?: string,
): Effect.Effect<void> =>
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
      legacyShadowBaselineTarsToEvict(entries, now, { retainFileName }),
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

const legacyAwaitShadowReady = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
  containerId: string,
  what: string,
): Effect.Effect<void, LegacyShadowCacheUnavailable, LegacyDbConnection> =>
  legacyWaitForShadowReady(spawner, containerId, legacyShadowConnConfig(input), {
    timeoutSeconds: input.healthTimeoutSeconds,
    image: input.image,
  }).pipe(
    Effect.mapError((cause) =>
      legacyShadowCacheUnavailable(`${what} never became ready: ${cause.message}`),
    ),
  );

// ---------------------------------------------------------------------------
// Cold export
// ---------------------------------------------------------------------------

/**
 * Ensures the tar's global cache directory exists, delegates the actual export to
 * {@link legacyExportPgDataTar} (`pgdata-snapshot.ts` — see that function's own doc comment for
 * the atomic-publish mechanics), then applies the LRU + TTL retention rule.
 */
const legacyWriteShadowBaselineTar = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
  tarPath: string,
  containerId: string,
): Effect.Effect<void, LegacyShadowCacheUnavailable> =>
  Effect.gen(function* () {
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
    yield* legacySweepShadowBaselineRetention(input, input.path.basename(tarPath));
  });

/**
 * Cold snapshot: stop → stamp → export → start → ready. Stop/export failures only
 * warn (run stays uncached). Restart/ready failure is fatal — the caller is about to
 * reconnect on the published port.
 */
const legacyExportShadowBaseline = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
  key: string,
  tarPath: string,
  containerId: string,
  keyedRolesSql: string,
): Effect.Effect<void, LegacyShadowDbError, Output | LegacyDbConnection> =>
  Effect.gen(function* () {
    const exported = yield* Effect.result(
      Effect.gen(function* () {
        // The key hashed roles.sql at acquire, but `legacySetupDatabase` rereads the file while
        // provisioning the baseline. An edit in that window would publish a tar whose key
        // describes stale bytes — skip publishing instead (run stays uncached).
        const rolesSqlNow = yield* input.fs
          .readFileString(input.path.join(input.workdir, "supabase", "roles.sql"))
          .pipe(
            Effect.catchTag("PlatformError", (error) =>
              Predicate.isTagged(error.reason, "NotFound")
                ? Effect.succeed("")
                : Effect.succeed(undefined),
            ),
          );
        if (rolesSqlNow !== keyedRolesSql) {
          return yield* Effect.fail(
            legacyShadowCacheUnavailable("supabase/roles.sql changed during provisioning"),
          );
        }
        yield* legacyShadowContainerVerb(spawner, "stop", containerId);
        yield* legacyStampPgDataBaselineMarker(spawner, containerId, key).pipe(
          Effect.mapError((cause: LegacyPgDataSnapshotUnavailable) =>
            legacyShadowCacheUnavailable(cause.reason),
          ),
        );
        yield* legacyWriteShadowBaselineTar(spawner, input, tarPath, containerId);
      }),
    );
    const revive = Effect.gen(function* () {
      yield* legacyShadowContainerVerb(spawner, "start", containerId);
      yield* legacyAwaitShadowReady(spawner, input, containerId, "re-started shadow");
    });
    yield* revive.pipe(
      Effect.mapError(
        (cause) =>
          new LegacyShadowDbError({
            message: `shadow database did not come back after the baseline snapshot: ${cause.reason}`,
            reason: "docker_daemon",
          }),
      ),
    );
    if (Result.isFailure(exported)) {
      const output = yield* Output;
      yield* output.raw(
        `Warning: shadow baseline not cached: ${exported.failure.reason}\n`,
        "stderr",
      );
    }
  });

// ---------------------------------------------------------------------------
// Acquire / release
// ---------------------------------------------------------------------------

export interface LegacyShadowCacheOpts {
  /** `sync --no-cache`: neither restore nor publish, regardless of the env gate. */
  readonly bypassCache?: boolean;
  /** Effective webhooks/`pg_net` policy — hashed so migrate/declarative snapshots cannot mix. */
  readonly webhooks?: LegacySetupDatabaseOptions["webhooks"];
}

/**
 * What `Effect.acquireUseRelease`'s `acquire` hands the `use` phase: the container, whether its
 * cluster already carries the platform baseline, and the snapshot step to run once a fresh
 * baseline is in place. Release needs nothing extra — every shadow this module hands out is
 * removed the same way an uncached one is.
 */
export interface LegacyShadowAcquiredHandle extends LegacyShadowBaselineState {
  readonly containerId: string;
  /**
   * The resolved shadow-baseline cache key this handle's cluster is keyed under — present
   * exactly when the acquisition was cache-eligible (a cold export or a warm restore), absent
   * for an uncached, `bypassCache`d, or uncachable one. Two handles carrying the SAME key share
   * the same tar's lineage: one either restored it or exported it this run, so their clusters
   * are physical clones of each other. `legacy-pgdelta-next-shadow.layer.ts` reads it to decide
   * whether pg-delta's same-database-identity guard must be bypassed for a plan's two shadows.
   */
  readonly snapshotKey?: string;
}

/** A throwaway shadow with no snapshot step — the cache-off path. */
const legacyUncachedShadow = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
): Effect.Effect<LegacyShadowAcquiredHandle, LegacyShadowDbError> =>
  legacyCreateShadowDatabase(spawner, input).pipe(
    Effect.map(({ containerId }) => ({
      containerId,
      baselinePresent: false,
      snapshotRequired: false,
      snapshotBaseline: Effect.void,
    })),
  );

/**
 * A cold, cache-enabled shadow: today's container plus the export step at the baseline seam.
 *
 * `autoRemove: false` is the one and only container-shape difference the cache introduces, and it
 * is forced: the export has to `docker stop` the container and `docker start` it again, and Docker
 * destroys an `--rm` container the moment it exits. Release still removes it with `docker rm -f
 * -v`, so the container's lifetime is unchanged — see
 * {@link LegacyCreateShadowDatabaseInput.autoRemove}.
 */
const legacyColdCachedShadow = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
  key: string,
  tarPath: string,
  keyedRolesSql: string,
): Effect.Effect<LegacyShadowAcquiredHandle, LegacyShadowDbError> =>
  legacyCreateShadowDatabase(spawner, { ...input, autoRemove: false }).pipe(
    Effect.map(({ containerId }) => ({
      containerId,
      snapshotKey: key,
      baselinePresent: false,
      snapshotRequired: true,
      snapshotBaseline: legacyExportShadowBaseline(
        spawner,
        input,
        key,
        tarPath,
        containerId,
        keyedRolesSql,
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
 * removes the container on that path, so re-enabling interruption cannot leak it.
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
    // is infra and leaves the tar in place; either verdict implicates its CONTENTS.
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
    const { containerId } = yield* legacyCreateShadowDatabase(spawner, {
      ...input,
      restoreArchive: legacyPgDataRestoreArchive(input.fs, tarPath),
    }).pipe(
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
    return {
      containerId,
      snapshotKey: key,
      baselinePresent: true,
      snapshotRequired: false,
      snapshotBaseline: Effect.void,
    } satisfies LegacyShadowAcquiredHandle;
  });

/**
 * `Effect.acquireUseRelease`'s `acquire` for every shadow-provisioning call site that runs the
 * platform baseline (`db diff`'s migra/pg-delta branch, `db pull`'s migration diff,
 * `legacy-pgdelta.cache.ts`'s catalog export, and pg-delta next's scoped shadows) — see
 * {@link legacyWithShadowDatabase} for the acquire/use/release wrapper, and
 * `legacy-pgdelta-next-shadow.layer.ts` for the scoped `acquireRelease` form next uses so the
 * container outlives provision (the engine keeps using the URL after this returns).
 *
 * Unset or falsey {@link LEGACY_SHADOW_CACHE_ENV} is the uncached create. Otherwise it
 * restores this key's snapshot (warm) or creates one and exports the baseline (cold).
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
      !legacyViperEnvBoolWithProjectFallback(
        LEGACY_SHADOW_CACHE_ENV,
        input.setup.projectEnvValues ?? {},
      )
    ) {
      return yield* legacyUncachedShadow(spawner, input);
    }

    // Interruptible: nothing acquired yet; JWKS discovery must not pin Ctrl-C.
    const keyInputs = yield* Effect.interruptible(legacyResolveShadowCacheKeyInputs(input, opts));
    if (Option.isNone(keyInputs)) return yield* legacyUncachedShadow(spawner, input);
    const key = legacyShadowCacheKey(keyInputs.value);
    const tarPath = input.path.join(
      legacyShadowBaselineCacheDir(input.path),
      legacyShadowBaselineTarFileName(key),
    );

    const cached = yield* input.fs.exists(tarPath).pipe(Effect.orElseSucceed(() => false));
    if (!cached)
      return yield* legacyColdCachedShadow(spawner, input, key, tarPath, keyInputs.value.rolesSql);

    // Warm hits refresh mtime and sweep leftovers the cold path would otherwise never see again.
    yield* legacyTouchShadowBaselineTar(input.fs, tarPath);
    yield* legacySweepAbandonedShadowBaselinePartials(input);
    yield* legacySweepShadowBaselineRetention(input, input.path.basename(tarPath));

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
          return yield* legacyColdCachedShadow(
            spawner,
            input,
            key,
            tarPath,
            keyInputs.value.rolesSql,
          );
        }),
      ),
    );
  });

/**
 * Acquire/use/release for a platform-baseline shadow. `acquireUseRelease` registers
 * removal in the same uninterruptible continuation as a successful create, so a
 * SIGINT between those steps cannot leak the container. A create that fails
 * after `docker create` still has the pre-existing leak window. Health-wait and
 * migrate stay in `use` so they stay interruptible. A JWKS failure during key
 * resolve propagates from acquire rather than degrading to an uncached shadow.
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
