/**
 * What a provisioning step hands the pipeline that follows it about the CLUSTER'S CONTENTS — the
 * one seam the baseline cache (`shadow-cache.ts`) needs, and nothing else uses — plus the ONE
 * session-shaped consequence every consumer draws from it ({@link legacyOpenBaselineSession}).
 *
 * Lives in its own module because both consumers sit on opposite sides of an import edge: the
 * throwaway shadow (`shadow-database.ts`, which imports `db-setup.ts`) and the long-running local
 * `db` container (`db-setup.ts`'s own `legacyRunFreshDbSetup`, via `main-db-baseline.ts`). Keeping
 * the shape here lets `db-setup.ts` accept it without importing `shadow-database.ts` back.
 *
 * Deliberately a value the provisioning step OWNS and returns (alongside the container id), not an
 * `afterBaseline` callback threaded down through the setup pipeline: the cache is the only party
 * that knows whether a cluster already carries a baseline and what to do once a fresh one exists,
 * so both answers travel together with the container the cache handed over.
 */

import { Effect } from "effect";

import type { Output } from "../../../shared/output/output.service.ts";
import type { LegacyDbConnection, LegacyDbSession } from "../legacy-db-connection.service.ts";

/**
 * A cluster restored from this key's PGDATA snapshot: it already carries the platform baseline
 * (`legacySetupDatabase`'s init schema + API privileges + vault + `roles.sql`), so re-running it
 * would be wasted work at best and a double-applied baseline at worst — and there is nothing left
 * to snapshot.
 */
export interface LegacyWarmBaselineState {
  readonly _tag: "warm";
}

/**
 * A cache-enabled COLD provision: the baseline still has to run, and the cluster it produces is
 * the one the cache publishes. The ONLY state whose {@link snapshotBaseline} really stops the
 * container, which is what the setup compositions key their SESSION structure on — see
 * {@link legacyOpenBaselineSession}.
 */
export interface LegacyColdBaselineState<SnapshotError> {
  readonly _tag: "cold";
  /**
   * Runs immediately after the FRESHLY provisioned baseline and strictly before anything else
   * touches the cluster (the shadow's template database/user migrations, the local `db`
   * container's `MigrateAndSeed`) — the only point at which `postgres` holds the pristine baseline
   * and nothing else.
   *
   * Takes NO session, and {@link legacyOpenBaselineSession} guarantees none is open against the
   * cluster while it runs: the snapshot is a disk-level PGDATA export that has to stop the
   * container.
   *
   * A cache that cannot SNAPSHOT degrades silently (warn + uncached run) — but the error channel
   * is not `never`, for the one failure that is the run's problem rather than the cache's: a
   * cluster that does not come back up after the export. Reporting success there would send the
   * caller's next connect to a dead (or worse, someone else's) Postgres on the published port —
   * see `legacyExportBaselineSnapshot`'s doc comment (`shadow-cache.ts`).
   *
   * `SnapshotError` is each cluster's own error vocabulary for that one failure
   * (`LegacyShadowDbError` for the shadow, `LegacyDbSetupError` for the local `db` container).
   */
  readonly snapshotBaseline: Effect.Effect<void, SnapshotError, Output | LegacyDbConnection>;
  /**
   * The `supabase/roles.sql` bytes the cache ALREADY read when it hashed this run's key
   * (`legacyResolveShadowCacheKeyInputs`, `shadow-cache.ts`; `""` when the file is absent).
   * Threaded into `legacySetupDatabase` so the seed executes exactly the bytes the key describes:
   * re-reading the file at seed time would let an edit landing in between publish a snapshot whose
   * contents disagree with the key it is published under.
   */
  readonly rolesSql: string;
}

/**
 * A run the cache never applies to (PG<=14, OrioleDB, `SUPABASE_SHADOW_CACHE=false`, an unreadable
 * `roles.sql`, `db start --from-backup`, `--no-cache`): provision the baseline, snapshot nothing.
 * Deliberately distinct from {@link LegacyColdBaselineState} — splitting sessions when no snapshot
 * will run would be a gratuitous behavior change, since a reconnect picks up role-level defaults
 * `roles.sql` may have just installed (e.g. `ALTER ROLE postgres SET statement_timeout`), which
 * Go's single-connection flow never exposed to migrations (review: Codex on #6184).
 */
export interface LegacyUncachedBaselineState {
  readonly _tag: "uncached";
}

/**
 * The three states a provisioning step can hand over, as a discriminated union: a cluster either
 * already carries the baseline (warm), or still needs one that will be snapshotted (cold), or
 * still needs one nobody will snapshot (uncached). Modelling it this way is what makes
 * "already has a baseline AND owes a snapshot" unrepresentable.
 */
export type LegacyClusterBaselineState<SnapshotError> =
  | LegacyWarmBaselineState
  | LegacyColdBaselineState<SnapshotError>
  | LegacyUncachedBaselineState;

/**
 * The baseline state every uncached caller passes. `never` in the error position makes this
 * assignable to any cluster's own {@link LegacyClusterBaselineState}.
 */
export const LEGACY_BASELINE_UNCACHED: LegacyClusterBaselineState<never> = { _tag: "uncached" };

/**
 * Opens the session everything AFTER the baseline runs on, running the baseline itself when this
 * state says it still has to — the identical three-way branch both setup compositions
 * (`db-setup.ts`'s `legacyRunFreshDbSetup` for the long-running local `db` container,
 * `shadow-database.ts`'s `legacyOpenShadowBaselineSession` for the throwaway shadow) used to spell
 * out separately:
 *
 * - **warm**: no baseline, no snapshot — just connect. The restored cluster already carries the
 *   platform baseline, so neither `Initialising schema...` nor `Seeding globals from roles.sql...`
 *   prints and the PG15+ one-shot migrate jobs never run.
 * - **cold**: run the baseline in its OWN scope so that session is CLOSED before
 *   {@link LegacyColdBaselineState.snapshotBaseline} stops the container (a disk-level export
 *   severs any live backend, and an open session holds SIGTERM's smart shutdown open until the
 *   grace period expires), then connect again for whatever follows.
 * - **uncached**: Go's single-connection flow, verbatim — baseline and everything after it on one
 *   session.
 *
 * The returned session's lifetime is the CALLER's enclosing `Scope.Scope` (Go's
 * `defer conn.Close(...)`), which is why `connect`'s own requirements leak through instead of
 * being wrapped in `Effect.scoped` here.
 */
export const legacyOpenBaselineSession = <SnapshotError, E, R, E2, R2>(
  connect: Effect.Effect<LegacyDbSession, E, R>,
  runBaseline: (session: LegacyDbSession) => Effect.Effect<void, E2, R2>,
  baseline: LegacyClusterBaselineState<SnapshotError>,
): Effect.Effect<LegacyDbSession, E | E2 | SnapshotError, R | R2 | Output | LegacyDbConnection> =>
  Effect.gen(function* () {
    if (baseline._tag === "cold") {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* runBaseline(yield* connect);
        }),
      );
      yield* baseline.snapshotBaseline;
    }
    const session = yield* connect;
    if (baseline._tag === "uncached") {
      yield* runBaseline(session);
    }
    return session;
  });

/**
 * The `roles.sql` bytes the cache already read for this run's key, when it read any — see
 * {@link LegacyColdBaselineState.rolesSql}. `undefined` on every other state: a warm cluster
 * never runs the seed at all, and an uncached run has no peek to inherit from, so it reads the
 * file itself exactly as before.
 */
export const legacyBaselineRolesSql = <SnapshotError>(
  baseline: LegacyClusterBaselineState<SnapshotError>,
): string | undefined => (baseline._tag === "cold" ? baseline.rolesSql : undefined);
