/**
 * Shadow baseline cache — the acquire/release pair `db diff`/`db pull`/the migrations-catalog
 * resolution path use in place of bare `legacyCreateShadowDatabase`/`legacyRemoveShadowDatabase`
 * (`shadow-database.ts`).
 *
 * The shadow database is on the hot path of every plan: a throwaway `supabase/postgres` container
 * brought to the platform baseline (init schema + the PG15+ one-shot realtime/storage/auth migrate
 * jobs) and then destroyed. That cold provision measures ~30s wall even with the readiness gate
 * fixed, of which ~11s is Postgres's own `initdb` + bundled init SQL and the rest the one-shot
 * jobs. None of it depends on the user's migrations, so it is cached — as a **disk-level PGDATA
 * snapshot**, not as a kept container:
 *
 *  - **Cold (no snapshot for this key):** create the shadow as an uncached run does (project
 *    labels only) and run today's baseline unchanged, then — immediately after the baseline and
 *    BEFORE `contrib_regression`/any user migration — `docker stop` the container, stream `docker
 *    cp <id>:/var/lib/postgresql/data -` into `supabase/.temp/pgdelta/shadow-baseline-<key>.tar`,
 *    and `docker start` + re-await readiness. Measured ~0.65s to export a 39MB bare-cluster
 *    snapshot (~90MB with the default services' one-shot jobs applied) and ~2s back to ready.
 *  - **Warm (that tar exists):** create the shadow exactly as an uncached run does, but unpack the
 *    tar into the created-but-not-yet-started container (`docker cp - <id>:/var/lib/postgresql`,
 *    ~0.6s) so `docker-entrypoint.sh` sees a `PG_VERSION` file and skips `initdb` entirely. The
 *    container is connectable ~2s after `docker start` with the full baseline cluster in place
 *    (all roles, `_supabase`, the versioned `auth`/`storage`/`_realtime` schemas), so the caller
 *    skips the baseline ({@link LegacyShadowBaselineState.baselinePresent}) and applies user
 *    migrations straight onto the restored `postgres`.
 *
 * **A plain file artifact on purpose.** The snapshot is a tar under the project's own temp
 * directory, not a Docker object, so nothing about the mechanism is Docker-specific: a future
 * NATIVE (non-container) Postgres service can restore the same artifact by unpacking it into its
 * own data directory.
 *
 * **No container outlives a run.** Every shadow this module hands out — cold, warm, or
 * cache-disabled — carries the same two project labels and is removed with `docker rm -f -v` on
 * release. Nothing is kept stopped between runs, there is no cache-key Docker label, and
 * `supabase stop` has nothing extra to sweep. The cache's only footprint outside one run is the
 * ~90MB tar.
 *
 * The single container-shape difference is on the cold path, and it is forced: that path drops
 * `--rm`, because Docker destroys an `AutoRemove` container the moment it exits — `docker stop`
 * included — which would leave nothing to restart after the export. See
 * {@link LegacyCreateShadowDatabaseInput.autoRemove} for the full consequence (a SIGKILLed CLI
 * leaves a stopped, project-labeled container instead of nothing).
 *
 * **Concurrency is safe by construction, with no lock file.** Every run creates its own fresh
 * container, so no two runs can ever contend for one cluster. The tar is published by writing a
 * temp file and `rename`-ing it into place, which is atomic: a reader either sees the previous
 * complete tar or the new complete tar, never a partial one, and a reader that already opened the
 * old inode keeps a valid fd across a rename-over. Two concurrent cold runs on the same key both
 * export and the last `rename` wins — both tars are equally valid, since the key covers every
 * input baked into the cluster.
 *
 * **The cache may never hand back a wrong baseline, and may never fail a run.** Every anomaly on
 * the warm path (the `docker cp` in, the start, the readiness wait) removes the suspect container,
 * DELETES the tar as suspect, and cold-provisions instead — worst case is exactly today's
 * behavior. A cold export that fails only warns on stderr and leaves the run uncached; the
 * container is always restarted afterwards, whether the export succeeded or not.
 *
 * Retention is "current key only": publishing a new key's tar removes every other
 * `shadow-baseline-*.tar` in the same directory, so a project holds ~90MB, not ~90MB per config
 * permutation it has ever used.
 *
 * `SUPABASE_SHADOW_CACHE` is ON by default; set it to `false`/`0` to opt out, in which case
 * `legacyAcquireShadowDatabase` is `legacyCreateShadowDatabase` and the release is
 * `legacyRemoveShadowDatabase` — same argv, same labels, same `--rm`, no extra Docker calls, no
 * files written.
 */

import { createHash } from "node:crypto";

import type { ProjectConfig } from "@supabase/config";
import { Effect, Option, Stream, type FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { Output } from "../../../shared/output/output.service.ts";
import {
  containerCliExitCode,
  legacyCollectText,
  legacyDescribeContainerCliFailure,
  spawnContainerCli,
} from "../legacy-container-cli.ts";
import { LegacyDbConnection } from "../legacy-db-connection.service.ts";
import type { LegacyPgConnInput } from "../legacy-db-connection.service.ts";
import { legacyPgDeltaTempPath } from "../legacy-pgdelta.paths.ts";
import { legacyParseBoolEnv } from "../legacy-diff-engine.ts";
import type { LegacyVaultSecret } from "../legacy-vault.ts";
import { legacyWaitForShadowReady } from "./health-check.ts";
import { legacyResolvePinnedImage } from "./pinned-image.ts";
import { legacyTimeShadowPhase } from "./shadow-debug.ts";
import {
  legacyCreateShadowDatabase,
  legacyRemoveShadowDatabase,
  type LegacyShadowBaselineState,
  type LegacyShadowDbError,
  type LegacyShadowSetupInput,
} from "./shadow-database.ts";

type Spawner = ChildProcessSpawner["Service"];

/** `SUPABASE_SHADOW_CACHE` — the opt-OUT gate for this whole module (default ON). */
export const LEGACY_SHADOW_CACHE_ENV = "SUPABASE_SHADOW_CACHE";

/**
 * `PGDATA` in every `supabase/postgres` image — the directory exported on the cold path and
 * restored on the warm one. Hardcoded rather than read from the container's own `PGDATA` env:
 * the entrypoint scripts this codebase generates (`postgres.service.ts`) never override it, and
 * the value is part of the tar's own layout, so a mismatch has to be a deliberate change here.
 */
export const LEGACY_SHADOW_PGDATA_PATH = "/var/lib/postgresql/data";

/**
 * `docker cp - <id>:<dest>` unpacks the archive's members RELATIVE to `dest`, and
 * {@link LEGACY_SHADOW_PGDATA_PATH}'s export tar has `data/` as its own top-level member, so the
 * restore target is PGDATA's parent. A POSIX constant, not `path.dirname` — this is a container
 * path and must not follow the host's separator.
 */
export const LEGACY_SHADOW_PGDATA_PARENT_PATH = "/var/lib/postgresql";

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
}

const legacyShadowCacheUnavailable = (reason: string): LegacyShadowCacheUnavailable => ({ reason });

/**
 * Whether the shadow baseline cache is enabled for this invocation.
 *
 * Unset (or empty) means ON — this is a default-on optimization, not a feature flag. A value that
 * IS set goes through the repo's `viper.GetBool` parser, so `SUPABASE_SHADOW_CACHE=false` and
 * `=0` opt out while `=1`/`=true` are explicit opt-ins.
 */
export function legacyShadowCacheEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env[LEGACY_SHADOW_CACHE_ENV];
  if (raw === undefined || raw.length === 0) return true;
  return legacyParseBoolEnv(raw);
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/** One of the three PG15+ one-shot migrate jobs, as the cache key sees it. */
export interface LegacyShadowCacheServiceInput {
  readonly enabled: boolean;
  /** `legacyResolvePinnedImage`'s resolved image — hashed ONLY when {@link enabled}, since a disabled service's job never ran into the baseline. */
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
 */
export interface LegacyShadowCacheKeyInputs {
  /** The resolved, full `supabase/postgres` image (tag included — a major version is not enough). */
  readonly postgresImage: string;
  readonly majorVersion: number;
  /**
   * The shadow's published host port. Not baked into PGDATA itself, but it IS part of the
   * container shape a snapshot is restored into, and a plan that changed it is a different plan —
   * cheap to include, and it keeps the key a superset of everything the container carries.
   */
  readonly shadowPort: number;
  readonly jwtSecret: string;
  readonly jwtExpiry: number;
  readonly rootKey: string;
  /** `[db] password` — baked into the cluster as the `postgres` role's password. */
  readonly dbPassword: string;
  readonly dbSettings: ProjectConfig["db"]["settings"];
  /** Effective `api.auto_expose_new_tables` tri-state (unset ≠ explicit `false`: only the former keeps the bundled grants). */
  readonly autoExposeNewTables: Option.Option<boolean>;
  /** `supabase/roles.sql`'s contents, `""` when absent. */
  readonly rolesSql: string;
  /** `[db.vault]` secrets — names AND values, both of which land in `vault.secrets`. */
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

const legacyTriStateToken = (value: Option.Option<boolean>) =>
  Option.isNone(value) ? "unset" : legacyBoolToken(value.value);

/**
 * The cache key: a 16-hex-char (64-bit) sha256 prefix over a fixed field order. 64 bits is
 * ample for a per-project local cache whose only cost of a collision would be a wrong baseline
 * — and every genuinely divergent input is in the payload, so a collision needs an actual hash
 * collision, not a missed field. Short enough to read in a filename.
 */
export function legacyShadowCacheKey(inputs: LegacyShadowCacheKeyInputs): string {
  const lines: Array<string> = [
    `postgres_image=${inputs.postgresImage}`,
    `major_version=${inputs.majorVersion}`,
    `shadow_port=${inputs.shadowPort}`,
    `jwt_secret=${inputs.jwtSecret}`,
    `jwt_expiry=${inputs.jwtExpiry}`,
    `root_key=${inputs.rootKey}`,
    `db_password=${inputs.dbPassword}`,
    `db_settings=${legacyCanonicalJson(inputs.dbSettings)}`,
    `auto_expose_new_tables=${legacyTriStateToken(inputs.autoExposeNewTables)}`,
  ];
  for (const name of ["realtime", "storage", "auth"] as const) {
    const service = inputs.services[name];
    lines.push(
      service.enabled
        ? `service=${name} enabled=true image=${service.image}`
        : `service=${name} enabled=false`,
    );
  }
  // Realtime's resolved JWKS — see the field's own doc comment for the compound
  // enabled+majorVersion gate (mirrors `service=realtime`'s own `enabled` exclusion above, plus
  // the PG15+ gate the one-shot job itself is behind).
  lines.push(
    inputs.services.realtime.enabled && inputs.majorVersion >= 15
      ? `realtime_jwks=${inputs.jwks}`
      : "realtime_jwks=excluded",
  );
  for (const secret of [...inputs.vault].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    lines.push(`vault=${secret.name}=${secret.value}`);
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
 * Returns `Option.none` (never a failure) for the one condition that makes the key
 * uncomputable — an unreadable `roles.sql` — so this function's OWN error channel carries
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
): Effect.Effect<Option.Option<LegacyShadowCacheKeyInputs>, E> =>
  Effect.gen(function* () {
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
      shadowPort: input.shadowPort,
      jwtSecret: input.jwtSecret,
      jwtExpiry: input.jwtExpiry,
      rootKey: input.rootKey ?? "",
      dbPassword: input.password,
      dbSettings: input.db.settings,
      autoExposeNewTables: input.setup.apiAutoExposeNewTables,
      rolesSql,
      vault: input.setup.vault,
      jwks,
      services: {
        realtime: {
          enabled: input.setup.config.realtime.enabled,
          image: legacyResolvePinnedImage("realtime", "realtime", overrides),
        },
        storage: {
          enabled: input.setup.config.storage.enabled,
          image: legacyResolvePinnedImage("storage", "storage", overrides),
        },
        auth: {
          enabled: input.setup.config.auth.enabled,
          image: legacyResolvePinnedImage("gotrue", "auth", overrides),
        },
      },
    } satisfies LegacyShadowCacheKeyInputs);
  });

// ---------------------------------------------------------------------------
// The tar artifact
// ---------------------------------------------------------------------------

/** Filename prefix shared by every key's snapshot — the handle the stale-key sweep enumerates by. */
const LEGACY_SHADOW_BASELINE_TAR_PREFIX = "shadow-baseline-";

const LEGACY_SHADOW_BASELINE_TAR_SUFFIX = ".tar";

/** `shadow-baseline-<key>.tar` under `supabase/.temp/pgdelta/` — one ~90MB file per key. */
export function legacyShadowBaselineTarFileName(key: string): string {
  return `${LEGACY_SHADOW_BASELINE_TAR_PREFIX}${key}${LEGACY_SHADOW_BASELINE_TAR_SUFFIX}`;
}

/**
 * Whether `fileName` is a baseline snapshot belonging to some OTHER key — i.e. one the "current
 * key only" retention rule removes when a new key's snapshot is published. Pure, so the retention
 * rule is unit-testable without a filesystem, and deliberately conservative: only files matching
 * this module's own prefix AND suffix are ever candidates, so nothing else in
 * `supabase/.temp/pgdelta/` (catalog snapshots, debug bundles) can be swept by accident.
 */
export function legacyIsStaleShadowBaselineTar(fileName: string, key: string): boolean {
  return (
    fileName.startsWith(LEGACY_SHADOW_BASELINE_TAR_PREFIX) &&
    fileName.endsWith(LEGACY_SHADOW_BASELINE_TAR_SUFFIX) &&
    fileName !== legacyShadowBaselineTarFileName(key)
  );
}

/**
 * The temp name a snapshot is streamed to before being `rename`d over the real one. Carries the
 * writing process's pid so two concurrent cold runs of the same key cannot truncate each other's
 * in-progress export — they publish independently, and the last `rename` wins (both tars are
 * equally valid; see this module's own header).
 */
function legacyShadowBaselineTarTempPath(tarPath: string): string {
  return `${tarPath}.${process.pid}.partial`;
}

/** Best-effort removal — a leftover tar only ever costs disk, never correctness. */
const legacyForgetShadowBaselineTar = (
  fs: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<void> => fs.remove(filePath).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Applies the "current key only" retention rule: every `shadow-baseline-*.tar` in the temp
 * directory whose key differs from `key` is removed. Best-effort throughout — a snapshot that
 * cannot be swept costs ~90MB of disk, so it must never fail the export that just succeeded.
 */
const legacySweepStaleShadowBaselineTars = <E>(
  input: LegacyShadowSetupInput<E>,
  key: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const tempDir = legacyPgDeltaTempPath(input.path, input.workdir);
    const entries = yield* input.fs
      .readDirectory(tempDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    yield* Effect.forEach(
      entries.filter((entry) => legacyIsStaleShadowBaselineTar(entry, key)),
      (entry) => legacyForgetShadowBaselineTar(input.fs, input.path.join(tempDir, entry)),
      { discard: true },
    );
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
const legacyAwaitShadowReady = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
  containerId: string,
  what: string,
): Effect.Effect<void, LegacyShadowCacheUnavailable, LegacyDbConnection> =>
  legacyWaitForShadowReady(spawner, containerId, legacyShadowConnConfig(input), {
    timeoutSeconds: input.healthTimeoutSeconds,
  }).pipe(
    Effect.mapError((cause) =>
      legacyShadowCacheUnavailable(`${what} never became ready: ${cause.message}`),
    ),
  );

// ---------------------------------------------------------------------------
// Cold export
// ---------------------------------------------------------------------------

/**
 * Streams `docker cp <id>:/var/lib/postgresql/data -`'s tar straight to a temp file and `rename`s
 * it into place. The stream never lands in memory: the child's stdout is piped into
 * `FileSystem.sink`, so an ~89MB snapshot costs one buffer's worth of heap.
 *
 * The `rename` is what publishes the entry, and it is the LAST step for exactly that reason: a
 * partially written tar must never be observable under the final name (a reader would restore a
 * truncated data directory and get a Postgres that will not start). Any failure removes the temp
 * file and reports the cache unavailable; nothing is left behind for the next run to find.
 */
const legacyWriteShadowBaselineTar = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
  key: string,
  tarPath: string,
  containerId: string,
): Effect.Effect<void, LegacyShadowCacheUnavailable> => {
  const tempPath = legacyShadowBaselineTarTempPath(tarPath);
  return Effect.gen(function* () {
    const tempDir = legacyPgDeltaTempPath(input.path, input.workdir);
    yield* input.fs
      .makeDirectory(tempDir, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          legacyShadowCacheUnavailable(`failed to create ${tempDir}: ${cause.message}`),
        ),
      );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawnContainerCli(
          spawner,
          ["cp", `${containerId}:${LEGACY_SHADOW_PGDATA_PATH}`, "-"],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        ).pipe(
          Effect.mapError((cause) =>
            legacyShadowCacheUnavailable(
              `failed to export ${LEGACY_SHADOW_PGDATA_PATH}: ${legacyDescribeContainerCliFailure(cause)}`,
            ),
          ),
        );
        // stdout is consumed concurrently with awaiting the exit code, not after it: an
        // unread pipe would block `docker cp` long before it finished writing 89MB.
        const [exitCode, , stderr] = yield* Effect.all(
          [
            child.exitCode.pipe(Effect.map(Number)),
            Stream.run(child.stdout, input.fs.sink(tempPath, { flag: "w" })),
            legacyCollectText(child.stderr),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError((cause) =>
            legacyShadowCacheUnavailable(
              `failed to export ${LEGACY_SHADOW_PGDATA_PATH}: ${legacyDescribeContainerCliFailure(cause)}`,
            ),
          ),
        );
        if (exitCode !== 0) {
          const message = stderr.trim();
          return yield* Effect.fail(
            legacyShadowCacheUnavailable(
              `docker cp exited ${exitCode}${message.length > 0 ? `: ${message}` : ""}`,
            ),
          );
        }
      }),
    );
    yield* input.fs
      .rename(tempPath, tarPath)
      .pipe(
        Effect.mapError((cause) =>
          legacyShadowCacheUnavailable(`failed to publish ${tarPath}: ${cause.message}`),
        ),
      );
    yield* legacySweepStaleShadowBaselineTars(input, key);
  }).pipe(Effect.onError(() => legacyForgetShadowBaselineTar(input.fs, tempPath)));
};

/**
 * The cold path's snapshot step, run at the baseline/migrations seam — after
 * `legacySetupDatabase` and strictly before `contrib_regression` or any user migration, with no
 * session open against the shadow ({@link LegacyShadowBaselineState.snapshotBaseline}).
 *
 * `docker stop` -> export -> `docker start` -> readiness wait. The container is stopped because a
 * live Postgres's PGDATA is not a coherent thing to copy; the stop is fast (~1s) because the
 * entrypoint `exec`s Postgres, so PID 1 receives the SIGTERM instead of `sh` swallowing it and
 * burning the full 10s grace period.
 *
 * Failure is not the run's problem — it only means this run stays uncached. The ONE thing that
 * must happen regardless is bringing the container back up: the caller is about to connect to it
 * again. So the restart runs whether the export succeeded or not, and only its own failure (which
 * dooms the run anyway, via the caller's next connect) outranks an export failure in the warning.
 */
const legacyExportShadowBaseline = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
  key: string,
  tarPath: string,
  containerId: string,
): Effect.Effect<void, never, Output | LegacyDbConnection> =>
  legacyTimeShadowPhase(
    "baseline-export",
    Effect.gen(function* () {
      yield* legacyShadowContainerVerb(spawner, "stop", containerId);
      // From here the container is DOWN; every exit path below has to start it again.
      const written = yield* Effect.result(
        legacyWriteShadowBaselineTar(spawner, input, key, tarPath, containerId),
      );
      yield* legacyShadowContainerVerb(spawner, "start", containerId);
      yield* legacyAwaitShadowReady(spawner, input, containerId, "re-started shadow");
      return yield* Effect.fromResult(written);
    }),
  ).pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        const output = yield* Output;
        yield* output.raw(`Warning: shadow baseline not cached: ${cause.reason}\n`, "stderr");
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Acquire / release
// ---------------------------------------------------------------------------

/**
 * What `Effect.acquireUseRelease`'s `acquire` hands the `use` phase: the container, whether its
 * cluster already carries the platform baseline, and the snapshot step to run once a fresh
 * baseline is in place. Release needs nothing extra — every shadow this module hands out is
 * removed the same way an uncached one is.
 */
export interface LegacyShadowAcquiredHandle extends LegacyShadowBaselineState {
  readonly containerId: string;
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
): Effect.Effect<LegacyShadowAcquiredHandle, LegacyShadowDbError> =>
  legacyCreateShadowDatabase(spawner, { ...input, autoRemove: false }).pipe(
    Effect.map(({ containerId }) => ({
      containerId,
      baselinePresent: false,
      snapshotBaseline: legacyExportShadowBaseline(spawner, input, key, tarPath, containerId),
    })),
  );

/**
 * The warm path proper: create the shadow with the snapshot tar unpacked into it before it starts
 * ({@link LegacyCreateShadowDatabaseInput.restoreArchive}), then wait for the restored Postgres.
 * Every failure resolves to {@link LegacyShadowCacheUnavailable}, which the caller turns into the
 * escape hatch.
 *
 * The readiness failure removes the container here rather than leaving it to the caller, because
 * the caller's fallback creates a REPLACEMENT container and the suspect one must be gone by then
 * (it holds the shadow's published port).
 */
const legacyWarmShadow = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
  tarPath: string,
): Effect.Effect<
  LegacyShadowAcquiredHandle,
  LegacyShadowCacheUnavailable,
  Output | LegacyDbConnection
> =>
  Effect.gen(function* () {
    const { containerId } = yield* legacyTimeShadowPhase(
      "baseline-restore",
      legacyCreateShadowDatabase(spawner, {
        ...input,
        restoreArchive: {
          containerPath: LEGACY_SHADOW_PGDATA_PARENT_PATH,
          tar: input.fs.stream(tarPath),
        },
      }),
    ).pipe(
      Effect.mapError((cause) =>
        legacyShadowCacheUnavailable(`failed to restore shadow baseline: ${cause.message}`),
      ),
    );
    yield* legacyAwaitShadowReady(spawner, input, containerId, "restored shadow").pipe(
      Effect.tapError(() => legacyRemoveShadowDatabase(spawner, containerId)),
    );
    return {
      containerId,
      baselinePresent: true,
      snapshotBaseline: Effect.void,
    } satisfies LegacyShadowAcquiredHandle;
  });

/**
 * `Effect.acquireUseRelease`'s `acquire` for every shadow-provisioning call site that runs the
 * platform baseline (`db diff`'s migra/pg-delta branch, `db pull`'s migration diff,
 * `legacy-pgdelta.cache.ts`'s catalog export) — see {@link legacyWithShadowDatabase}, which is
 * what those call sites actually use.
 *
 * With {@link LEGACY_SHADOW_CACHE_ENV} set to a falsey value this IS `legacyCreateShadowDatabase`,
 * byte for byte. Otherwise it resolves the cache key and either restores this key's snapshot into
 * a fresh container (warm) or creates one and arranges for its baseline to be exported (cold).
 * Either way the container itself is created identically to an uncached one.
 *
 * Runs inside `acquireUseRelease`'s uninterruptible `acquire`, same as
 * `legacyCreateShadowDatabase` — a warm restore adds ~2s of uninterruptible work (a `docker cp -`
 * plus a readiness probe); the multi-second baseline/migration sequence stays in the interruptible
 * `use` phase exactly as before.
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
): Effect.Effect<
  LegacyShadowAcquiredHandle,
  LegacyShadowDbError | E,
  Output | LegacyDbConnection
> =>
  Effect.gen(function* () {
    if (!legacyShadowCacheEnabled()) return yield* legacyUncachedShadow(spawner, input);

    const keyInputs = yield* legacyResolveShadowCacheKeyInputs(input);
    if (Option.isNone(keyInputs)) return yield* legacyUncachedShadow(spawner, input);
    const key = legacyShadowCacheKey(keyInputs.value);
    const tarPath = input.path.join(
      legacyPgDeltaTempPath(input.path, input.workdir),
      legacyShadowBaselineTarFileName(key),
    );

    const cached = yield* input.fs.exists(tarPath).pipe(Effect.orElseSucceed(() => false));
    if (!cached) return yield* legacyColdCachedShadow(spawner, input, key, tarPath);

    return yield* legacyWarmShadow(spawner, input, tarPath).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const output = yield* Output;
          yield* output.raw(
            `Warning: cached shadow baseline unusable (${cause.reason}); recreating.\n`,
            "stderr",
          );
          // The tar is the suspect: a restore that produced an unstartable cluster will produce
          // one again on every later run, so it is deleted rather than retried forever.
          yield* legacyForgetShadowBaselineTar(input.fs, tarPath);
          return yield* legacyColdCachedShadow(spawner, input, key, tarPath);
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
): Effect.Effect<A, E2 | LegacyShadowDbError | E, R2 | Output | LegacyDbConnection> =>
  Effect.acquireUseRelease(legacyAcquireShadowDatabase(spawner, input), use, (handle) =>
    legacyRemoveShadowDatabase(spawner, handle.containerId),
  );
