/**
 * Orchestration for pg-delta next's two plan shadows (migrations + declarative) — the strategy
 * choice, the concurrency runner, and the output buffering that keeps the user-visible
 * transcript free of cross-fiber interleaving. Extracted from
 * `legacy-pgdelta-next-shadow.layer.ts` so the branch logic, the baseline-handoff signal, and
 * the flush ordering are unit-testable with plain fakes instead of a full Docker/runtime layer
 * graph.
 *
 * The three strategies, chosen from a {@link legacyPeekShadowBaseline} of each shadow:
 *
 * - `parallel` — both snapshots are published: both provisions warm-restore concurrently. A warm
 *   provision skips the platform baseline entirely (`legacySetupShadowDatabase`'s
 *   `baselinePresent` branch), so the declarative fiber prints nothing and the migrations fiber's
 *   `Applying migration ...` lines stream live and in order.
 * - `baseline-handoff` — both are cold with the SAME cache key (their `setup.webhooks` policies
 *   resolve to the same effective boolean): the baseline is
 *   paid exactly once. The migrations shadow cold-provisions; its snapshot export runs at the
 *   baseline seam (after platform setup, before migration replay) and signals the declarative
 *   fiber, which then warm-restores from the just-published tar CONCURRENTLY with the migration
 *   replay. All normal-mode output still comes from the single migrations fiber.
 * - `sequential` — everything else (different keys, mixed warm/cold, `--no-cache`, cache env off,
 *   PG<=14/OrioleDB): no baseline can be shared, so run migrations then declarative exactly as
 *   the pre-parallel code did, preserving that transcript byte for byte.
 */

import { Deferred, Effect } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import type { LegacyShadowBaselinePeek } from "../../../shared/db-bootstrap/shadow-cache.ts";

export type LegacyPlanShadowStrategy = "parallel" | "baseline-handoff" | "sequential";

/**
 * Pure strategy choice from the two peeks. Equal-key implies equal warm/cold state (one key =
 * one tar), so `cold`+`cold`+equal-keys is the only shareable-baseline shape; a mixed warm/cold
 * pair always means different keys, where nothing can be shared and sequential keeps the cold
 * side's baseline prints off the migration replay's live stream.
 */
export function legacyResolvePlanShadowStrategy(
  migrations: LegacyShadowBaselinePeek,
  declarative: LegacyShadowBaselinePeek,
): LegacyPlanShadowStrategy {
  if (migrations.state === "warm" && declarative.state === "warm") return "parallel";
  if (
    migrations.state === "cold" &&
    declarative.state === "cold" &&
    migrations.key === declarative.key
  ) {
    return "baseline-handoff";
  }
  return "sequential";
}

/**
 * Runs the two provisions under the chosen strategy.
 *
 * `provisionMigrations` receives an `onBaselineSeam` effect it MUST arrange to run once its
 * baseline seam passes (the snapshot-export point, before migration replay) — the layer wires it
 * into the acquired handle's `snapshotBaseline` via `Effect.ensuring`, and fires it immediately
 * when the acquired handle will never run a snapshot (a warm or uncached acquire, e.g. when
 * another process published the tar between peek and acquire). The runner additionally
 * `Effect.ensuring`s the signal onto the WHOLE migrations provision as a liveness backstop, so
 * the declarative waiter can never deadlock: seam reached → early signal; provision ends without
 * a seam (success, failure, or interruption) → backstop signal, and on failure `Effect.all`'s
 * fail-fast interrupts the waiter anyway.
 */
export const legacyRunPlanShadowProvisions = <M, D, EM, ED, RM, RD>(opts: {
  readonly strategy: LegacyPlanShadowStrategy;
  readonly provisionMigrations: (onBaselineSeam: Effect.Effect<void>) => Effect.Effect<M, EM, RM>;
  readonly provisionDeclarative: Effect.Effect<D, ED, RD>;
}): Effect.Effect<readonly [M, D], EM | ED, RM | RD> => {
  switch (opts.strategy) {
    case "parallel":
      return Effect.all([opts.provisionMigrations(Effect.void), opts.provisionDeclarative], {
        concurrency: 2,
      });
    case "baseline-handoff":
      return Effect.gen(function* () {
        const seam = yield* Deferred.make<void>();
        const signal = Deferred.succeed(seam, undefined).pipe(Effect.asVoid);
        return yield* Effect.all(
          [
            opts.provisionMigrations(signal).pipe(Effect.ensuring(signal)),
            Deferred.await(seam).pipe(Effect.andThen(opts.provisionDeclarative)),
          ],
          { concurrency: 2 },
        );
      });
    case "sequential":
      return Effect.gen(function* () {
        const migrations = yield* opts.provisionMigrations(Effect.void);
        const declarative = yield* opts.provisionDeclarative;
        return [migrations, declarative] as const;
      });
  }
};

export interface LegacyBufferedShadowOutput {
  /** The wrapped service to provide to the fiber whose writes must not interleave. */
  readonly output: typeof Output.Service;
  /**
   * Replays every buffered write to the real output, in order. Run it AFTER the live fiber has
   * finished (e.g. `Effect.ensuring` on the join, not on the buffered fiber — the buffered fiber
   * can finish first, and flushing then would interleave after all). Idempotent; writes arriving
   * after a flush pass straight through live so late teardown warnings are never lost.
   */
  readonly flush: Effect.Effect<void>;
}

/**
 * An {@link Output} decorator that buffers `raw`/`rawBytes` (the only channels the shadow
 * provisioning paths write to) and delegates everything else live. This is the hard guarantee
 * that a concurrently provisioned shadow can never land a line BETWEEN two of the live fiber's
 * lines — in normal mode the buffer stays empty (a warm restore prints nothing), so this exists
 * for the anomaly paths: cache warnings and cold-fallback baseline prints.
 *
 * Deliberately NOT covering writes that bypass `Output` entirely (`SUPABASE_SHADOW_DEBUG` timing
 * lines and failure-path container-log dumps write straight to `process.stderr`) — those are
 * opt-in diagnostics where immediacy beats ordering.
 */
export function legacyBufferedShadowOutput(
  real: typeof Output.Service,
): LegacyBufferedShadowOutput {
  type BufferedWrite =
    | { readonly kind: "raw"; readonly text: string; readonly stream: "stdout" | "stderr" }
    | {
        readonly kind: "rawBytes";
        readonly bytes: Uint8Array;
        readonly stream: "stdout" | "stderr";
      };
  const buffer: Array<BufferedWrite> = [];
  let flushed = false;
  const output = Output.of({
    ...real,
    raw: (text, stream = "stdout") =>
      Effect.suspend(() => {
        if (flushed) return real.raw(text, stream);
        buffer.push({ kind: "raw", text, stream });
        return Effect.void;
      }),
    rawBytes: (bytes, stream = "stdout") =>
      Effect.suspend(() => {
        if (flushed) return real.rawBytes(bytes, stream);
        buffer.push({ kind: "rawBytes", bytes, stream });
        return Effect.void;
      }),
  });
  const flush = Effect.suspend(() => {
    flushed = true;
    const pending = buffer.splice(0);
    return Effect.forEach(
      pending,
      (write) =>
        write.kind === "raw"
          ? real.raw(write.text, write.stream)
          : real.rawBytes(write.bytes, write.stream),
      { discard: true },
    );
  });
  return { output, flush };
}
