/**
 * Shadow baseline cache — the acquire/release pair `db diff`/`db pull`/the migrations-catalog
 * resolution path use in place of bare `legacyCreateShadowDatabase`/`legacyRemoveShadowDatabase`
 * (`shadow-database.ts`). Caches the shadow's platform baseline (init schema + the PG15+ one-shot
 * realtime/storage/auth jobs) as a disk-level PGDATA snapshot, never a kept container.
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
 * snapshot fails the run — see `legacyExportShadowBaseline`); tars live under the global
 * `${SUPABASE_HOME}/cache/shadow-baseline/` (shared across worktrees with the same settings),
 * with LRU (keep 8) + 14-day mtime TTL retention. `SUPABASE_SHADOW_CACHE` is ON by default;
 * `false`/`0` opts out.
 */

import { createHash } from "node:crypto";

import type { ProjectConfig } from "@supabase/config";
import { Clock, Effect, Option, Result, type FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { Output } from "../../../shared/output/output.service.ts";
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
import { legacyExportPgDataTar, legacyPgDataRestoreArchive } from "./pgdata-snapshot.ts";
import type { LegacyPgDataSnapshotUnavailable } from "./pgdata-snapshot.ts";
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
   * `true` only when the failure implicates the TAR'S CONTENTS — today, exactly one producer: a
   * restored cluster that started but never accepted connections ({@link legacyWarmShadow}'s
   * readiness wait). Everything else (a `docker create`/`cp`/`start` failure — daemon outage,
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
  /** Effective `api.auto_expose_new_tables` tri-state (unset ≠ explicit `false`: only the former keeps the bundled grants). */
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
 * Digest of every CLI-EMBEDDED SQL text baked into the baseline cluster — the inputs that change
 * with a CLI release rather than with the project's config: the PG15+ entrypoint's initdb heredocs
 * (schema/webhook/_supabase — `postgres.service.ts`) and the API privilege revocation. Without this
 * line, a CLI upgrade that edits a grant, schema statement, or revocation WITHOUT bumping the
 * postgres image would warm-restore the previous release's baseline (review: depthfirst on #6184).
 * Computed once at module load — these are compile-time constants. When adding a new embedded SQL
 * step to the baseline (`legacySetupDatabase`/the entrypoint scripts), add its text here too.
 *
 * Deliberately EXCLUDES PG<=14's own setup SQL (`LEGACY_START_DB_GLOBALS_SQL`,
 * `LEGACY_START_DB_INITIAL_SCHEMA_13_SQL`/`_14_SQL`): PG<=14 is cache-ineligible —
 * {@link legacyResolveShadowCacheKeyInputs} returns `Option.none()` for `majorVersion <= 14` before
 * any key is computed, so no cluster keyed by this digest can ever have run through that SQL. If
 * PG<=14 ever becomes cache-eligible, those templates must be re-added here.
 */
const LEGACY_SHADOW_BASELINE_SQL_DIGEST = createHash("sha256")
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

const legacyTriStateToken = (value: Option.Option<boolean>) =>
  Option.isNone(value) ? "unset" : legacyBoolToken(value.value);

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
    `auto_expose_new_tables=${legacyTriStateToken(inputs.autoExposeNewTables)}`,
    `webhooks_enabled=${legacyBoolToken(inputs.webhooksEnabled)}`,
    // Not a per-run input — see the digest's own doc comment for what it covers and why.
    `baseline_sql_digest=${LEGACY_SHADOW_BASELINE_SQL_DIGEST}`,
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
    yield* legacySweepShadowBaselineRetention(input);
  });

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
 * Two failure classes, deliberately NOT one broad catch: a stop/export failure only means this
 * run stays uncached — it warns and the run continues. A restart/readiness failure is the RUN'S
 * problem: the caller is about to reconnect to the shadow's published port, and reporting success
 * over a dead container would make that connect a blind dial — which can even reach a DIFFERENT
 * Postgres that claimed the port while the container was down (matching default credentials are
 * common locally), applying the template + migrations to the wrong database. So the restart runs
 * whether the export succeeded or not (`docker start` on an already-running container — e.g. when
 * the stop itself failed — is a no-op success), and its failure PROPAGATES as a
 * {@link LegacyShadowDbError} instead of degrading (review: Codex on #6184).
 */
const legacyExportShadowBaseline = <E>(
  spawner: Spawner,
  input: LegacyShadowSetupInput<E>,
  key: string,
  tarPath: string,
  containerId: string,
): Effect.Effect<void, LegacyShadowDbError, Output | LegacyDbConnection> =>
  legacyTimeShadowPhase(
    "baseline-export",
    Effect.gen(function* () {
      // Cache-degradable phase: stop + export. A failure here (including a failed stop, after
      // which the container is simply still up) only costs this run its snapshot.
      const exported = yield* Effect.result(
        Effect.gen(function* () {
          yield* legacyShadowContainerVerb(spawner, "stop", containerId);
          yield* legacyWriteShadowBaselineTar(spawner, input, tarPath, containerId);
        }),
      );
      // Run-critical phase: the shadow must be back up and answering before this step reports
      // success — see this function's own doc comment for why these failures must propagate.
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
    }),
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
): Effect.Effect<LegacyShadowAcquiredHandle, LegacyShadowDbError> =>
  legacyCreateShadowDatabase(spawner, { ...input, autoRemove: false }).pipe(
    Effect.map(({ containerId }) => ({
      containerId,
      snapshotKey: key,
      baselinePresent: false,
      snapshotRequired: true,
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
    // for a finalizer to release.
    const keyInputs = yield* Effect.interruptible(legacyResolveShadowCacheKeyInputs(input, opts));
    if (Option.isNone(keyInputs)) return yield* legacyUncachedShadow(spawner, input);
    const key = legacyShadowCacheKey(keyInputs.value);
    const tarPath = input.path.join(
      legacyShadowBaselineCacheDir(input.path),
      legacyShadowBaselineTarFileName(key),
    );

    const cached = yield* input.fs.exists(tarPath).pipe(Effect.orElseSucceed(() => false));
    if (!cached) return yield* legacyColdCachedShadow(spawner, input, key, tarPath);

    // Warm hits refresh mtime (so frequently used keys survive LRU/TTL) and sweep abandoned
    // partials — a killed concurrent writer's leftover would otherwise persist indefinitely once
    // every later run goes warm, since the cold export's own sweep never runs again (review:
    // Codex on #6184). Best-effort and cheap.
    yield* legacyTouchShadowBaselineTar(input.fs, tarPath);
    yield* legacySweepAbandonedShadowBaselinePartials(input);
    yield* legacySweepShadowBaselineRetention(input);

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
  opts: LegacyShadowCacheOpts = {},
): Effect.Effect<A, E2 | LegacyShadowDbError | E, R2 | Output | LegacyDbConnection> =>
  Effect.acquireUseRelease(legacyAcquireShadowDatabase(spawner, input, opts), use, (handle) =>
    legacyRemoveShadowDatabase(spawner, handle.containerId),
  );
