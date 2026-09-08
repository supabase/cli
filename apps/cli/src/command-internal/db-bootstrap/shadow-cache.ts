/**
 * Shadow baseline cache for `db diff`/`db pull`/catalog resolution. Snapshots the platform
 * baseline as a PGDATA tar under `${SUPABASE_HOME}/cache/shadow-baseline/` (keep 3, 2-day TTL).
 * On by default; an explicitly set `SUPABASE_SHADOW_CACHE` that is not viper-true (`0`/`false`/
 * empty/garbage, from the shell env or the project dotenv) turns it off. A cache miss or
 * anomaly never fails the run except when the shadow does not come back after a cold export.
 */

import { createHash, scryptSync } from "node:crypto";

import type { CliConfig } from "@supabase/config";
import {
  Clock,
  Effect,
  Match,
  Option,
  Predicate,
  Result,
  Semaphore,
  type FileSystem,
} from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { viperEnvBoolWithProjectFallback } from "../viper-env.ts";
import { Output } from "../../shared/output/output.service.ts";
import { containerCliExitCode, describeContainerCliFailure } from "../container-cli.ts";
import { DbConnection } from "../db-connection.service.ts";
import { getRegistryImageUrl } from "../docker-registry.ts";
import { shadowBaselineCacheDir } from "../pgdelta.paths.ts";
import { POSTGRES_DEFAULT_ROOT_KEY } from "../local-config-values.ts";
import {
  START_ENABLE_DATABASE_WEBHOOKS_SQL,
  START_REVOKE_API_PRIVILEGES_SQL,
  type SetupDatabaseOptions,
  resolveSetupWebhooksEnabled,
} from "./db-setup.ts";
import { START_INTERNAL_DB_NAME, START_INTERNAL_DB_PORT } from "./internal-db-connection.ts";
import { REALTIME_DB_USER, REALTIME_ENCRYPTION_KEY, REALTIME_TENANT_ID } from "./realtime-env.ts";
import { START_DB_SCHEMA_SQL } from "./templates/db-schema.sql.ts";
import { START_DB_SUPABASE_SQL } from "./templates/db-supabase.sql.ts";
import { START_DB_WEBHOOK_SQL } from "./templates/db-webhook.sql.ts";
import { CREATE_VAULT_KV, READ_VAULT_KV, UPDATE_VAULT_KV, type VaultSecret } from "../vault.ts";
import { waitForShadowReady } from "./health-check.ts";
import {
  exportPgDataTar,
  pgDataRestoreArchive,
  stampPgDataBaselineMarker,
  validatePgDataArchive,
} from "./pgdata-snapshot.ts";
import type { PgDataArchiveProblem, PgDataSnapshotUnavailable } from "./pgdata-snapshot.ts";
import { resolvePinnedImage } from "./pinned-image.ts";
import {
  createShadowDatabase,
  removeShadowDatabase,
  shadowConnConfig,
  type ShadowBaselineState,
  ShadowDbError,
  type ShadowSetupInput,
} from "./shadow-database.ts";

type Spawner = ChildProcessSpawner["Service"];

/** `SUPABASE_SHADOW_CACHE` — opt-out gate (viper bool when set; unset is ON). */
export const SHADOW_CACHE_ENV = "SUPABASE_SHADOW_CACHE";

/**
 * Internal-only "the cache cannot be used" signal. Deliberately NOT a `Data.TaggedError`: it
 * never reaches a user or telemetry — every producer is caught by
 * {@link acquireShadowDatabase} (which falls back to a cold provision) or by
 * {@link exportShadowBaseline} (which warns and continues uncached), so classifying it as a
 * CLI error would be misleading, and would pollute the error-actionability vocabulary with a
 * failure the user can neither see nor act on.
 */
interface ShadowCacheUnavailable {
  readonly reason: string;
  /**
   * `true` only when the failure implicates the TAR'S CONTENTS — today, exactly three producers,
   * all in {@link warmShadow}: an archive whose header stream is missing a required entry —
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

const shadowCacheUnavailable = (
  reason: string,
  opts: { readonly tarSuspect?: boolean } = {},
): ShadowCacheUnavailable => ({ reason, ...opts });

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/** One of the three PG15+ one-shot migrate jobs, as the cache key sees it. */
interface ShadowCacheServiceInput {
  readonly enabled: boolean;
  /** Registry-resolved image; hashed only when {@link enabled}. */
  readonly image: string;
}

/**
 * Inputs baked into the shadow cluster. Separate from `setupInputsToken`:
 * that catalog key hashes vault names only and omits job image tags.
 */
export interface ShadowCacheKeyInputs {
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
  readonly dbSettings: CliConfig["db"]["settings"];
  /**
   * `api.auto_expose_new_tables` as config carries it (tri-state). Hashed as the
   * effective two-state behavior — see {@link effectiveShadowApiGrantsKept}.
   */
  readonly autoExposeNewTables: Option.Option<boolean>;
  /**
   * Effective Webhooks/`pg_net` policy `setupDatabase` applies. Legacy
   * migrate forces enabled; next declarative forces disabled; next migrate
   * follows config.
   */
  readonly webhooksEnabled: boolean;
  /** `supabase/roles.sql`'s contents, `""` when absent. */
  readonly rolesSql: string;
  /**
   * `[db.vault]` secrets — names AND values, both of which land in `vault.secrets`. Only
   * RESOLVED entries are hashed ({@link shadowCacheKey}), because the upsert skips
   * unresolved ones entirely — see the loop's own comment there.
   */
  readonly vault: ReadonlyArray<VaultSecret>;
  readonly services: {
    readonly realtime: ShadowCacheServiceInput;
    readonly storage: ShadowCacheServiceInput;
    readonly auth: ShadowCacheServiceInput;
  };
  /**
   * The resolved JWKS string (`ShadowDbSetupInput.jwks`, an `Effect` the caller resolves
   * lazily) that realtime's one-shot tenant-seed job bakes into the cluster
   * (`buildRealtimeEnv`'s `jwks` field, `db-setup.ts`) — a config change under
   * `auth.third_party` changes this value without touching anything else in this struct, so it
   * needs its own field rather than folding into `services.realtime`. Hashed ONLY when
   * `services.realtime` is enabled AND `majorVersion >= 15` — the exact compound gate
   * {@link resolveDbSetupPrelude} itself uses to decide whether to resolve (and therefore
   * whether the one-shot job ever consumes) this same effect during a real setup: a disabled or
   * pre-PG15 realtime never reaches the job that reads it. `""` when excluded, mirroring
   * {@link ShadowCacheServiceInput.image}.
   */
  readonly jwks: string;
}

/**
 * Digest of CLI-embedded literals baked into the baseline (initdb heredocs, privilege
 * SQL, vault upsert SQL, Realtime seed constants). Lazy: these are compile-time constants.
 * PG<=14 setup SQL is excluded because that major is cache-ineligible.
 */
let shadowBaselineEmbeddedDigestMemo: string | undefined;
const shadowBaselineEmbeddedDigest = (): string =>
  (shadowBaselineEmbeddedDigestMemo ??= createHash("sha256")
    .update(
      [
        START_DB_SCHEMA_SQL,
        START_DB_WEBHOOK_SQL,
        START_DB_SUPABASE_SQL,
        START_REVOKE_API_PRIVILEGES_SQL,
        START_ENABLE_DATABASE_WEBHOOKS_SQL,
        READ_VAULT_KV,
        UPDATE_VAULT_KV,
        CREATE_VAULT_KV,
        REALTIME_TENANT_ID,
        REALTIME_ENCRYPTION_KEY,
        REALTIME_DB_USER,
        START_INTERNAL_DB_NAME,
        String(START_INTERNAL_DB_PORT),
      ].join("\n--8<--\n"),
      "utf8",
    )
    .digest("hex"));

/** JSON with recursively key-sorted objects, so `db.settings`' own property order cannot change the key. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
}

/**
 * The two-state behavior `applyApiPrivileges` (`db-setup.ts`) actually derives from
 * `api.auto_expose_new_tables`' tri-state: unset and explicit `true` both keep the grants and bake
 * the exact same cluster; only an explicit `false` execs
 * {@link START_REVOKE_API_PRIVILEGES_SQL}. Hashing the raw tri-state would split unset from
 * `true` into different keys and force a spurious ~90MB re-snapshot for a config edit that changes
 * nothing on disk.
 */
const effectiveShadowApiGrantsKept = (value: Option.Option<boolean>): boolean =>
  Option.getOrElse(value, () => true);

/**
 * The cache key: a 16-hex-char (64-bit) scrypt prefix over a fixed field order. 64 bits is
 * ample for a per-settings global cache whose only cost of a collision would be a wrong baseline
 * — and every genuinely divergent input is in the payload, so a collision needs an actual hash
 * collision, not a missed field. Short enough to read in a filename.
 *
 * scrypt, not a fast hash: the payload embeds `jwt_secret`, `root_key`, `db_password`, and
 * resolved vault values (excluding them would fingerprint the wrong PGDATA), and the key lands
 * in filenames, where a fast hash invites offline brute-force toward those secrets
 * (CodeQL js/insufficient-password-hash). The fixed salt is deliberate: the key must stay
 * deterministic across runs, or the cache never hits.
 */
export function shadowCacheKey(inputs: ShadowCacheKeyInputs): string {
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
    `db_settings=${canonicalJson(inputs.dbSettings)}`,
    `api_grants_kept=${effectiveShadowApiGrantsKept(inputs.autoExposeNewTables)}`,
    `webhooks_enabled=${inputs.webhooksEnabled}`,
    `baseline_embedded_digest=${shadowBaselineEmbeddedDigest()}`,
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
  // because the consuming one-shot job (`startInitSchema15`) is behind the same gate.
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
  return scryptSync(payload, "supabase-shadow-cache-key", 32).toString("hex").slice(0, 16);
}

/**
 * Resolves {@link ShadowCacheKeyInputs} from the same run input the shadow container
 * itself is built from, plus `supabase/roles.sql` off disk. The service enabled flags come from
 * `setup.config` (NOT the `*EnabledForSetup` fields, which only gate JWKS resolution) because
 * `setupDatabase`'s own one-shot job gates read exactly those config fields.
 *
 * Returns `Option.none` (never a failure) for the two conditions that make caching
 * unavailable — an OrioleDB cluster (whose state is partly external, see the body's own
 * comment) and an unreadable `roles.sql` — so this function's OWN error channel carries
 * nothing but `E`: the `input.setup.jwks` effect below is `yield*`ed unguarded (only when the
 * consuming realtime job is actually reachable — see the field's own doc comment), and a real
 * JWKS failure must fail this whole acquire exactly as it would have failed a real setup, never
 * be folded into a cache-miss the way {@link ShadowCacheUnavailable} failures are
 * elsewhere in this module. Keeping the two failure modes on separate channels (`Option.none`
 * vs. a genuine `Effect` failure) is what lets the caller (`acquireShadowDatabase`)
 * degrade the former to an uncached shadow while letting the latter propagate, without an `as`
 * cast to tell them apart.
 */

const resolveShadowCacheKeyInputs = <E>(
  input: ShadowSetupInput<E>,
  opts: ShadowCacheOpts = {},
): Effect.Effect<Option.Option<ShadowCacheKeyInputs>, E> =>
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
    // The same registry rewrite `runStartMigrateJob`'s `ensureImagesCached` applies
    // when the job actually runs (same `projectEnvValues`-then-ambient precedence) — see
    // {@link ShadowCacheServiceInput.image}.
    const resolveJobImage = (image: string): string =>
      getRegistryImageUrl(image, input.setup.projectEnvValues);
    // The exact compound gate {@link resolveDbSetupPrelude} uses to decide whether the
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
      // The EFFECTIVE value, not the raw input: `buildShadowPostgresContainerSpec`
      // (`postgres.service.ts`) falls back to the embedded default when unset, so hashing `""`
      // would fail to re-key if that security-sensitive default ever rotates between CLI
      // releases.
      rootKey: input.rootKey ?? POSTGRES_DEFAULT_ROOT_KEY,
      dbPassword: input.password,
      dbSettings: input.db.settings,
      storageTargetMigration: input.setup.storageTargetMigration,
      autoExposeNewTables: input.setup.apiAutoExposeNewTables,
      webhooksEnabled: resolveSetupWebhooksEnabled(opts.webhooks, input.setup.webhooksEnabled),
      rolesSql,
      vault: input.setup.vault,
      jwks,
      services: {
        realtime: {
          enabled: input.setup.config.realtime.enabled,
          image: resolveJobImage(resolvePinnedImage("realtime", "realtime", overrides)),
        },
        storage: {
          enabled: input.setup.config.storage.enabled,
          image: resolveJobImage(resolvePinnedImage("storage", "storage", overrides)),
        },
        auth: {
          enabled: input.setup.config.auth.enabled,
          image: resolveJobImage(resolvePinnedImage("gotrue", "auth", overrides)),
        },
      },
    } satisfies ShadowCacheKeyInputs);
  });

// ---------------------------------------------------------------------------
// The tar artifact
// ---------------------------------------------------------------------------

/** Filename prefix shared by every key's snapshot — the handle the retention sweep enumerates by. */
const SHADOW_BASELINE_TAR_PREFIX = "shadow-baseline-";

const SHADOW_BASELINE_TAR_SUFFIX = ".tar";

/** Cap on published tars in the global cache (~90MB each). */
export const SHADOW_BASELINE_KEEP = 3;

/** Drop unused published tars older than 2 days (warm hits refresh mtime). */
export const SHADOW_BASELINE_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * `shadow-baseline-<key>.tar` under `${SUPABASE_HOME}/cache/shadow-baseline/` — one ~90MB file
 * per settings key, shared across worktrees.
 */
export function shadowBaselineTarFileName(key: string): string {
  return `${SHADOW_BASELINE_TAR_PREFIX}${key}${SHADOW_BASELINE_TAR_SUFFIX}`;
}

/**
 * Whether `fileName` is a published baseline snapshot (`shadow-baseline-<key>.tar`). Pure and
 * deliberately conservative: only this module's own prefix AND suffix, so partials
 * (`…tar.<pid>.partial`) and any unrelated file in the cache dir are never eviction candidates.
 */
export function isShadowBaselineTar(fileName: string): boolean {
  return (
    fileName.startsWith(SHADOW_BASELINE_TAR_PREFIX) &&
    fileName.endsWith(SHADOW_BASELINE_TAR_SUFFIX) &&
    fileName.length ===
      SHADOW_BASELINE_TAR_PREFIX.length + 16 + SHADOW_BASELINE_TAR_SUFFIX.length &&
    /^shadow-baseline-[0-9a-f]{16}\.tar$/u.test(fileName)
  );
}

/** One published tar as the LRU/TTL rule sees it — name + mtime, no filesystem. */
export interface ShadowBaselineTarEntry {
  readonly fileName: string;
  readonly mtimeMs: number;
}

export interface ShadowBaselineRetentionOpts {
  readonly keep?: number;
  readonly maxAgeMs?: number;
  /** Never evict this published tar, even if it is older than the TTL or over the cap. */
  readonly retainFileName?: string;
}

/**
 * Pure LRU + age eviction: drop every published tar older than `maxAgeMs`, then among the
 * survivors keep the newest `keep` by mtime. The current run's tar is never evicted.
 */
export function shadowBaselineTarsToEvict(
  entries: ReadonlyArray<ShadowBaselineTarEntry>,
  now: number,
  opts: ShadowBaselineRetentionOpts = {},
): ReadonlyArray<string> {
  const keep = opts.keep ?? SHADOW_BASELINE_KEEP;
  const maxAgeMs = opts.maxAgeMs ?? SHADOW_BASELINE_MAX_AGE_MS;
  const retain = opts.retainFileName;
  const candidates = entries.filter(
    (entry) => isShadowBaselineTar(entry.fileName) && entry.fileName !== retain,
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
const forgetShadowBaselineTar = (
  fs: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<void> => fs.remove(filePath).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Whether `fileName` is one of {@link exportPgDataTar}'s in-flight temp files
 * (`shadow-baseline-<key>.tar.<pid>.partial`). Pure name check only — whether it is ABANDONED
 * (crashed/SIGKILLed writer, whose `Effect.onError` cleanup never ran) is an mtime question the
 * sweep answers separately, so a concurrent writer's live temp file is never a candidate by name
 * alone.
 */
export function isShadowBaselinePartial(fileName: string): boolean {
  return /^shadow-baseline-[0-9a-f]{16}\.tar\.\d+\.partial$/u.test(fileName);
}

/** A partial older than 5 minutes is abandoned; a live export finishes in seconds. */
const SHADOW_PARTIAL_ABANDON_MS = 5 * 60 * 1000;

/**
 * Removes abandoned `.partial` temp files (see {@link isShadowBaselinePartial}) — the one
 * artifact a SIGKILLed/crashed cold export leaves behind that nothing else ever cleans: later
 * runs use their own pid in the temp name, and the tar retention sweep deliberately ignores
 * `.partial` names — best-effort throughout.
 */
const sweepAbandonedShadowBaselinePartials = <E>(input: ShadowSetupInput<E>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const cacheDir = shadowBaselineCacheDir(input.path);
    const entries = yield* input.fs
      .readDirectory(cacheDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(
      entries.filter(isShadowBaselinePartial),
      (entry) =>
        Effect.gen(function* () {
          const filePath = input.path.join(cacheDir, entry);
          const info = yield* input.fs.stat(filePath);
          const mtime = Option.getOrUndefined(info.mtime);
          if (mtime !== undefined && now - mtime.getTime() > SHADOW_PARTIAL_ABANDON_MS) {
            yield* forgetShadowBaselineTar(input.fs, filePath);
          }
        }).pipe(Effect.orElseSucceed(() => undefined)),
      { discard: true },
    );
  });

/**
 * Applies the global-cache LRU + TTL retention rule (see {@link shadowBaselineTarsToEvict}).
 * Best-effort throughout — a snapshot that cannot be swept costs ~90MB of disk, so it must never
 * fail the export or warm hit that just succeeded.
 */
const sweepShadowBaselineRetention = <E>(
  input: ShadowSetupInput<E>,
  retainFileName?: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const cacheDir = shadowBaselineCacheDir(input.path);
    const names = yield* input.fs
      .readDirectory(cacheDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const now = yield* Clock.currentTimeMillis;
    const entries: Array<ShadowBaselineTarEntry> = [];
    for (const fileName of names) {
      if (!isShadowBaselineTar(fileName)) continue;
      const info = yield* input.fs
        .stat(input.path.join(cacheDir, fileName))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (info === undefined) continue;
      const mtime = Option.getOrUndefined(info.mtime);
      if (mtime === undefined) continue;
      entries.push({ fileName, mtimeMs: mtime.getTime() });
    }
    yield* Effect.forEach(
      shadowBaselineTarsToEvict(entries, now, { retainFileName }),
      (fileName) => forgetShadowBaselineTar(input.fs, input.path.join(cacheDir, fileName)),
      { discard: true },
    );
  });

/** Refresh mtime on a warm hit so frequently used keys survive LRU/TTL. Best-effort. */
const touchShadowBaselineTar = (fs: FileSystem.FileSystem, tarPath: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const now = new Date(yield* Clock.currentTimeMillis);
    yield* fs.utimes(tarPath, now, now);
  }).pipe(Effect.orElseSucceed(() => undefined));

// ---------------------------------------------------------------------------
// Container primitives the cache adds on top of `shadow-database.ts`
// ---------------------------------------------------------------------------

/**
 * `docker <verb> <id>`, resolving to {@link ShadowCacheUnavailable} on anything but a clean
 * exit. Both verbs this is used for (`stop`, `start`) are steps the export cannot proceed without,
 * so a non-zero exit is an anomaly rather than something to tolerate.
 */
const shadowContainerVerb = (
  spawner: Spawner,
  verb: "start" | "stop",
  containerId: string,
): Effect.Effect<void, ShadowCacheUnavailable> =>
  containerCliExitCode(spawner, [verb, containerId], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).pipe(
    Effect.mapError((cause) =>
      shadowCacheUnavailable(
        `failed to ${verb} shadow container: ${describeContainerCliFailure(cause)}`,
      ),
    ),
    Effect.flatMap((exitCode) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail(shadowCacheUnavailable(`docker ${verb} exited ${exitCode}`)),
    ),
  );

const awaitShadowReady = <E>(
  spawner: Spawner,
  input: ShadowSetupInput<E>,
  containerId: string,
  what: string,
): Effect.Effect<void, ShadowCacheUnavailable, DbConnection> =>
  waitForShadowReady(spawner, containerId, shadowConnConfig(input), {
    timeoutSeconds: input.healthTimeoutSeconds,
    image: input.image,
  }).pipe(
    Effect.mapError((cause) =>
      shadowCacheUnavailable(`${what} never became ready: ${cause.message}`),
    ),
  );

// ---------------------------------------------------------------------------
// Cold export
// ---------------------------------------------------------------------------

/**
 * Serializes same-process cold exports. Two shadows provisioned concurrently in one process
 * (pg-delta next's plan shadows) can both reach the export step, and with an equal key they
 * would race on the same `<tar>.<pid>.partial` temp path — `exportPgDataTar` scopes its
 * temp name by pid alone. One permit makes that interleaving impossible; cross-process writers
 * were never affected (distinct pids).
 */
const shadowExportMutex = Semaphore.makeUnsafe(1);

/**
 * Ensures the tar's global cache directory exists, delegates the actual export to
 * {@link exportPgDataTar} (`pgdata-snapshot.ts` — see that function's own doc comment for
 * the atomic-publish mechanics), then applies the LRU + TTL retention rule. Runs under
 * {@link shadowExportMutex}.
 *
 * `skipIfPublished` dedupes same-key sibling exports: when the tar was absent at acquire time,
 * one published while this fiber waited on the permit is a sibling's snapshot of this same
 * baseline. It must be `false` on the warm-fallback cold path, where a tar deliberately
 * retained despite an unusable restore is sitting at this path waiting to be atomically
 * replaced.
 */
const writeShadowBaselineTar = <E>(
  spawner: Spawner,
  input: ShadowSetupInput<E>,
  tarPath: string,
  containerId: string,
  skipIfPublished: boolean,
): Effect.Effect<void, ShadowCacheUnavailable> =>
  shadowExportMutex.withPermit(
    Effect.gen(function* () {
      if (skipIfPublished) {
        const published = yield* input.fs.exists(tarPath).pipe(Effect.orElseSucceed(() => false));
        if (published) return;
      }
      const cacheDir = shadowBaselineCacheDir(input.path);
      yield* input.fs
        .makeDirectory(cacheDir, { recursive: true, mode: 0o700 })
        .pipe(
          Effect.mapError((cause) =>
            shadowCacheUnavailable(`failed to create ${cacheDir}: ${cause.message}`),
          ),
        );
      yield* sweepAbandonedShadowBaselinePartials(input);
      yield* exportPgDataTar(spawner, containerId, input.fs, tarPath).pipe(
        Effect.mapError((cause: PgDataSnapshotUnavailable) => shadowCacheUnavailable(cause.reason)),
      );
      yield* sweepShadowBaselineRetention(input, input.path.basename(tarPath));
    }),
  );

/**
 * Cold snapshot: stop → stamp → export → start → ready. Stop/export failures only
 * warn (run stays uncached). Restart/ready failure is fatal — the caller is about to
 * reconnect on the published port.
 */
const exportShadowBaseline = <E>(
  spawner: Spawner,
  input: ShadowSetupInput<E>,
  key: string,
  tarPath: string,
  containerId: string,
  keyedRolesSql: string,
  skipIfPublished: boolean,
): Effect.Effect<void, ShadowDbError, Output | DbConnection> =>
  Effect.gen(function* () {
    const exported = yield* Effect.result(
      Effect.gen(function* () {
        // The key hashed roles.sql at acquire, but `setupDatabase` rereads the file while
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
            shadowCacheUnavailable("supabase/roles.sql changed during provisioning"),
          );
        }
        yield* shadowContainerVerb(spawner, "stop", containerId);
        yield* stampPgDataBaselineMarker(spawner, containerId, key).pipe(
          Effect.mapError((cause: PgDataSnapshotUnavailable) =>
            shadowCacheUnavailable(cause.reason),
          ),
        );
        yield* writeShadowBaselineTar(spawner, input, tarPath, containerId, skipIfPublished);
      }),
    );
    const revive = Effect.gen(function* () {
      yield* shadowContainerVerb(spawner, "start", containerId);
      yield* awaitShadowReady(spawner, input, containerId, "re-started shadow");
    });
    yield* revive.pipe(
      Effect.mapError(
        (cause) =>
          new ShadowDbError({
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

export interface ShadowCacheOpts {
  /** `sync --no-cache`: neither restore nor publish, regardless of the env gate. */
  readonly bypassCache?: boolean;
  /** Effective webhooks/`pg_net` policy — hashed so migrate/declarative snapshots cannot mix. */
  readonly webhooks?: SetupDatabaseOptions["webhooks"];
  /**
   * Key inputs a caller already resolved via {@link peekShadowBaseline}, so
   * {@link acquireShadowDatabase} does not resolve them a second time. Resolution can
   * include a live JWKS discovery request (realtime on PG15+). Must have been computed from the
   * same `input`/`opts` pair, or the acquire keys against the wrong snapshot.
   */
  readonly precomputedKeyInputs?: ShadowCacheKeyInputs;
}

/** What {@link peekShadowBaseline} learned about a would-be acquire, without provisioning. */
export type ShadowBaselinePeek =
  /** Bypassed, env-disabled, or key-ineligible (PG<=14, OrioleDB, unreadable roles.sql). */
  | { readonly state: "uncachable" }
  | {
      readonly state: "cold" | "warm";
      readonly key: string;
      /** Pass back via {@link ShadowCacheOpts.precomputedKeyInputs} to skip re-resolution. */
      readonly keyInputs: ShadowCacheKeyInputs;
    };

/**
 * Answers "what would {@link acquireShadowDatabase} do for this input right now?" without
 * creating a container. Callers use it to choose an orchestration (pg-delta next's plan
 * provisioning picks parallel / baseline-handoff / sequential), never to skip the acquire's own
 * re-checks: the answer can go stale between peek and acquire, and the acquire re-deciding on
 * current disk state keeps that race merely suboptimal rather than incorrect.
 *
 * The error channel is the key resolution's own `E` (a JWKS resolution failure) — same rationale
 * as {@link acquireShadowDatabase}.
 */
export const peekShadowBaseline = <E>(
  input: ShadowSetupInput<E>,
  opts: ShadowCacheOpts = {},
): Effect.Effect<ShadowBaselinePeek, E> =>
  Effect.gen(function* () {
    if (
      opts.bypassCache === true ||
      !viperEnvBoolWithProjectFallback(SHADOW_CACHE_ENV, input.setup.projectEnvValues ?? {})
    ) {
      return { state: "uncachable" } as const;
    }
    const keyInputs = yield* resolveShadowCacheKeyInputs(input, opts);
    if (Option.isNone(keyInputs)) return { state: "uncachable" } as const;
    const key = shadowCacheKey(keyInputs.value);
    const tarPath = input.path.join(
      shadowBaselineCacheDir(input.path),
      shadowBaselineTarFileName(key),
    );
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
export interface ShadowAcquiredHandle extends ShadowBaselineState {
  readonly containerId: string;
  /**
   * The resolved shadow-baseline cache key this handle's cluster is keyed under — present
   * exactly when the acquisition was cache-eligible (a cold export or a warm restore), absent
   * for an uncached, `bypassCache`d, or uncachable one. Two handles carrying the SAME key share
   * the same tar's lineage: one either restored it or exported it this run, so their clusters
   * are physical clones of each other. `pgdelta-next-shadow.layer.ts` reads it to decide
   * whether pg-delta's same-database-identity guard must be bypassed for a plan's two shadows.
   */
  readonly snapshotKey?: string;
}

/** A throwaway shadow with no snapshot step — the cache-off path. */
const uncachedShadow = <E>(
  spawner: Spawner,
  input: ShadowSetupInput<E>,
): Effect.Effect<ShadowAcquiredHandle, ShadowDbError> =>
  createShadowDatabase(spawner, input).pipe(
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
 * {@link CreateShadowDatabaseInput.autoRemove}.
 *
 * `skipIfPublished` must reflect whether the tar was absent when this cold acquisition began —
 * see {@link writeShadowBaselineTar}.
 */
const coldCachedShadow = <E>(
  spawner: Spawner,
  input: ShadowSetupInput<E>,
  key: string,
  tarPath: string,
  keyedRolesSql: string,
  skipIfPublished: boolean,
): Effect.Effect<ShadowAcquiredHandle, ShadowDbError> =>
  createShadowDatabase(spawner, { ...input, autoRemove: false }).pipe(
    Effect.map(({ containerId }) => ({
      containerId,
      snapshotKey: key,
      baselinePresent: false,
      snapshotRequired: true,
      snapshotBaseline: exportShadowBaseline(
        spawner,
        input,
        key,
        tarPath,
        containerId,
        keyedRolesSql,
        skipIfPublished,
      ),
    })),
  );

/** A cache key as {@link shadowCacheKey} produces it — 16 hex chars, nothing else. */
const SHADOW_CACHE_KEY_PATTERN = /^[0-9a-f]{16}$/u;

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
const describeShadowArchiveProblem = (problem: PgDataArchiveProblem): string =>
  Match.valueTags(problem, {
    "missing-entries": (missing) => `snapshot has no ${missing.entries.join(" or ")} entry`,
    "wrong-key": (wrongKey) => {
      const found =
        wrongKey.found !== undefined && SHADOW_CACHE_KEY_PATTERN.test(wrongKey.found)
          ? `key ${wrongKey.found}`
          : "an unreadable key";
      return `snapshot is stamped with ${found}, not ${wrongKey.expected}`;
    },
  });

/**
 * The warm path proper: verify the snapshot tar really carries a baselined cluster, create the
 * shadow with it unpacked into it before it starts ({@link CreateShadowDatabaseInput.restoreArchive}),
 * then wait for the restored Postgres. Every failure resolves to
 * {@link ShadowCacheUnavailable}, which the caller turns into the escape hatch.
 *
 * The readiness failure removes the container here rather than leaving it to the caller, because
 * the caller's fallback creates a REPLACEMENT container and the suspect one must be gone by then
 * (it holds the shadow's published port).
 *
 * The readiness wait is explicitly `Effect.interruptible`: this whole function runs inside
 * `Effect.acquireUseRelease`'s uninterruptible `acquire` ({@link withShadowDatabase}), and
 * while the restore itself is short (~2s of `docker create` + `docker cp -`), a restored container
 * that starts but never accepts connections would otherwise pin a Ctrl-C for the full
 * `healthTimeoutSeconds` budget — exactly the swallowed-SIGINT shape `prepareShadowSource`'s
 * own doc comment (`shadow-source.ts`) was restructured to avoid. `Effect.onInterrupt`
 * removes the container on that path, so re-enabling interruption cannot leak it.
 */
const warmShadow = <E>(
  spawner: Spawner,
  input: ShadowSetupInput<E>,
  key: string,
  tarPath: string,
): Effect.Effect<ShadowAcquiredHandle, ShadowCacheUnavailable, Output | DbConnection> =>
  Effect.gen(function* () {
    // An archive that unpacks cleanly but carries the wrong thing is the ONE corruption the restore
    // itself cannot report: `docker cp -` extracts whatever it is given, the entrypoint skips
    // `initdb` (or runs one over an empty PGDATA), readiness passes, and this function would hand
    // back `baselinePresent: true` for a cluster that never saw `setupDatabase` — the caller
    // then skips it too and diffs against a BARE database, silently producing wrong SQL. The same
    // shape hides a second lie: a fully baselined snapshot of ANOTHER key, copied over this key's
    // filename, restores just as cleanly while carrying different roles/vault values/service
    // schema. So the tar's own headers are scanned BEFORE anything is created (locally, no Docker)
    // for the cluster file, for the baseline marker this module stamps immediately before every
    // export, AND for that marker's key — see {@link validatePgDataArchive}. A read failure
    // is infra and leaves the tar in place; either verdict implicates its CONTENTS.
    const problem = yield* validatePgDataArchive(input.fs, tarPath, key).pipe(
      Effect.mapError((cause) => shadowCacheUnavailable(cause.reason)),
    );
    if (Option.isSome(problem)) {
      return yield* Effect.fail(
        shadowCacheUnavailable(describeShadowArchiveProblem(problem.value), {
          tarSuspect: true,
        }),
      );
    }
    const { containerId } = yield* createShadowDatabase(spawner, {
      ...input,
      restoreArchive: pgDataRestoreArchive(input.fs, tarPath),
    }).pipe(
      Effect.mapError((cause) =>
        shadowCacheUnavailable(`failed to restore shadow baseline: ${cause.message}`),
      ),
    );
    yield* awaitShadowReady(spawner, input, containerId, "restored shadow").pipe(
      // The ONE failure that implicates the tar's contents: the restored cluster started but
      // never accepted connections — see {@link ShadowCacheUnavailable.tarSuspect}.
      Effect.mapError((cause) => shadowCacheUnavailable(cause.reason, { tarSuspect: true })),
      Effect.tapError(() => removeShadowDatabase(spawner, containerId)),
      Effect.onInterrupt(() => removeShadowDatabase(spawner, containerId)),
      Effect.interruptible,
    );
    return {
      containerId,
      snapshotKey: key,
      baselinePresent: true,
      snapshotRequired: false,
      snapshotBaseline: Effect.void,
    } satisfies ShadowAcquiredHandle;
  });

/**
 * `Effect.acquireUseRelease`'s `acquire` for every shadow-provisioning call site that runs the
 * platform baseline (`db diff`'s migra/pg-delta branch, `db pull`'s migration diff, and
 * pg-delta's scoped shadows) — see
 * {@link withShadowDatabase} for the acquire/use/release wrapper, and
 * `pgdelta-next-shadow.layer.ts` for the scoped `acquireRelease` form next uses so the
 * container outlives provision (the engine keeps using the URL after this returns).
 *
 * An explicitly falsey {@link SHADOW_CACHE_ENV} (set, but not viper-true) is the
 * uncached create. Otherwise — including when the variable is unset, the default — it
 * restores this key's snapshot (warm) or creates one and exports the baseline (cold).
 *
 * Runs inside `acquireUseRelease`'s uninterruptible `acquire`, same as
 * `createShadowDatabase` — a warm restore adds ~2s of uninterruptible work (a `docker cp -`);
 * its readiness wait re-enables interruption explicitly (see {@link warmShadow}), and the
 * multi-second baseline/migration sequence stays in the interruptible `use` phase exactly as
 * before.
 *
 * The `E` in the error channel is {@link resolveShadowCacheKeyInputs}'s own JWKS
 * resolution alone (see that function's doc comment): every OTHER failure this function's own
 * body can produce while computing the key or restoring the snapshot is caught and degraded — an
 * unusable cache root to the plain uncached shadow (with a warning), anything on the warm path to
 * a cold provision — a genuine JWKS failure is the one case that must reach the caller instead,
 * since a real cold provision at this input would have failed the same way.
 */
export const acquireShadowDatabase = <E>(
  spawner: Spawner,
  input: ShadowSetupInput<E>,
  opts: ShadowCacheOpts = {},
): Effect.Effect<ShadowAcquiredHandle, ShadowDbError | E, Output | DbConnection> =>
  Effect.gen(function* () {
    if (
      opts.bypassCache === true ||
      !viperEnvBoolWithProjectFallback(SHADOW_CACHE_ENV, input.setup.projectEnvValues ?? {}, {
        whenUnset: true,
      })
    ) {
      return yield* uncachedShadow(spawner, input);
    }

    // Interruptible: nothing acquired yet; JWKS discovery must not pin Ctrl-C.
    const keyInputs = yield* Effect.interruptible(
      opts.precomputedKeyInputs !== undefined
        ? Effect.succeed(Option.some(opts.precomputedKeyInputs))
        : resolveShadowCacheKeyInputs(input, opts),
    );
    if (Option.isNone(keyInputs)) return yield* uncachedShadow(spawner, input);

    // The cache root must be usable BEFORE committing to the cached lifecycle: the cold path
    // drops `--rm` and pays a stop → export → restart cycle whose write is already doomed when
    // this directory cannot be written (an unwritable or root-squashed `SUPABASE_HOME`) — and
    // with the cache on by default, every affected invocation would pay that cycle just to warn.
    // The mkdir is the exact one the export performs (which keeps its own as a safety net for a
    // root that vanishes mid-run), but alone it is not a sufficient probe: recursive mkdir on an
    // ALREADY-EXISTING directory creates nothing and succeeds regardless of permission, so the
    // `access(W_OK)` check is what catches a pre-existing read-only root (EACCES for the current
    // user, EROFS on a read-only mount, a root-squashing NFS server's denial).
    const cacheDir = shadowBaselineCacheDir(input.path);
    const cacheRoot = yield* Effect.result(
      input.fs
        .makeDirectory(cacheDir, { recursive: true, mode: 0o700 })
        .pipe(Effect.andThen(input.fs.access(cacheDir, { writable: true }))),
    );
    if (Result.isFailure(cacheRoot)) {
      const output = yield* Output;
      yield* output.raw(
        `Warning: shadow baseline cache unavailable (cannot write ${cacheDir}: ${cacheRoot.failure.message}); continuing uncached.\n`,
        "stderr",
      );
      return yield* uncachedShadow(spawner, input);
    }

    const key = shadowCacheKey(keyInputs.value);
    const tarPath = input.path.join(cacheDir, shadowBaselineTarFileName(key));

    const cached = yield* input.fs.exists(tarPath).pipe(Effect.orElseSucceed(() => false));
    if (!cached)
      return yield* coldCachedShadow(spawner, input, key, tarPath, keyInputs.value.rolesSql, true);

    // Warm hits refresh mtime and sweep leftovers the cold path would otherwise never see again.
    yield* touchShadowBaselineTar(input.fs, tarPath);
    yield* sweepAbandonedShadowBaselinePartials(input);
    yield* sweepShadowBaselineRetention(input, input.path.basename(tarPath));

    return yield* warmShadow(spawner, input, key, tarPath).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const output = yield* Output;
          yield* output.raw(
            `Warning: cached shadow baseline unusable (${cause.reason}); recreating.\n`,
            "stderr",
          );
          // Delete ONLY when the failure implicates the tar's contents (a restored cluster that
          // came up broken) — see {@link ShadowCacheUnavailable.tarSuspect} for why an
          // infra or extraction failure leaves it in place (the cold fallback's own export
          // republishes over a genuinely bad tar anyway).
          if (cause.tarSuspect === true) {
            yield* forgetShadowBaselineTar(input.fs, tarPath);
          }
          return yield* coldCachedShadow(
            spawner,
            input,
            key,
            tarPath,
            keyInputs.value.rolesSql,
            false,
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
export const withShadowDatabase = <E, A, E2, R2>(
  spawner: Spawner,
  input: ShadowSetupInput<E>,
  use: (handle: ShadowAcquiredHandle) => Effect.Effect<A, E2, R2>,
  opts: ShadowCacheOpts = {},
): Effect.Effect<A, E2 | ShadowDbError | E, R2 | Output | DbConnection> =>
  Effect.acquireUseRelease(acquireShadowDatabase(spawner, input, opts), use, (handle) =>
    removeShadowDatabase(spawner, handle.containerId),
  );
