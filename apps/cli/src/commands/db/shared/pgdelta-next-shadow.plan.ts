/**
 * Orchestration for pg-delta next's two plan shadows: the concurrency strategy chosen from each
 * shadow's cache peek ({@link resolvePlanShadowStrategy}), the runner for it
 * ({@link runPlanShadowProvisions}), and output buffering ({@link bufferedShadowOutput}).
 */

import { Chunk, Deferred, Effect, Ref } from "effect";

import { Output } from "../../../shared/output/output.service.ts";
import type { ShadowBaselinePeek } from "../../../command-internal/db-bootstrap/shadow-cache.ts";

export type PlanShadowStrategy = "parallel" | "baseline-handoff" | "sequential";

/**
 * Pure strategy choice from the two peeks: equal-key implies equal warm/cold state, so only
 * `cold`+`cold` with equal keys shares a baseline. A mixed warm/cold pair always means
 * different keys, so sequential keeps the cold side's baseline prints off the live stream.
 */
export function resolvePlanShadowStrategy(
  migrations: ShadowBaselinePeek,
  declarative: ShadowBaselinePeek,
): PlanShadowStrategy {
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
 * Runs the two provisions under the chosen strategy. `provisionMigrations` must fire
 * `onBaselineSeam` once its snapshot-export point passes (immediately if the acquired handle
 * never snapshots); the runner also `Effect.ensuring`s that signal onto the whole migrations
 * provision as a liveness backstop, so the declarative waiter can never deadlock.
 */
export const runPlanShadowProvisions = <M, D, EM, ED, RM, RD>(opts: {
  readonly strategy: PlanShadowStrategy;
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

export interface BufferedShadowOutput {
  /** The wrapped service to provide to the fiber whose writes must not interleave. */
  readonly output: typeof Output.Service;
  /**
   * Replays every buffered write to the real output, in order; idempotent, and writes after a
   * flush pass straight through live so late teardown warnings are never lost. Run this after
   * the live fiber joins, not after the buffered fiber (which can finish first).
   */
  readonly flush: Effect.Effect<void>;
}

/**
 * An {@link Output} decorator that buffers `raw`/`rawBytes` and delegates everything else live,
 * so a concurrently provisioned shadow's writes can never land mid-line in the other fiber's
 * live transcript. The buffer stays empty in the common case (a warm restore prints nothing) and
 * only holds anomaly-path output (cache warnings, cold-fallback baseline prints); it does not
 * cover writes that bypass `Output`, such as `SUPABASE_SHADOW_DEBUG` timing lines.
 */
export const bufferedShadowOutput = Effect.fnUntraced(function* (
  real: typeof Output.Service,
): Effect.fn.Return<BufferedShadowOutput> {
  type BufferedWrite =
    | { readonly kind: "raw"; readonly text: string; readonly stream: "stdout" | "stderr" }
    | {
        readonly kind: "rawBytes";
        readonly bytes: Uint8Array;
        readonly stream: "stdout" | "stderr";
      };
  const state = yield* Ref.make<{
    readonly flushed: boolean;
    readonly buffer: Chunk.Chunk<BufferedWrite>;
  }>({ flushed: false, buffer: Chunk.empty() });
  const write = (pending: BufferedWrite) =>
    pending.kind === "raw"
      ? real.raw(pending.text, pending.stream)
      : real.rawBytes(pending.bytes, pending.stream);
  const bufferOrWrite = (pending: BufferedWrite) =>
    Ref.modify(state, (current) =>
      current.flushed
        ? [true, current]
        : [false, { flushed: false, buffer: Chunk.append(current.buffer, pending) }],
    ).pipe(Effect.flatMap((live) => (live ? write(pending) : Effect.void)));
  const output = Output.of({
    ...real,
    raw: (text, stream = "stdout") => bufferOrWrite({ kind: "raw", text, stream }),
    rawBytes: (bytes, stream = "stdout") => bufferOrWrite({ kind: "rawBytes", bytes, stream }),
  });
  const flush = Ref.getAndSet(state, { flushed: true, buffer: Chunk.empty() }).pipe(
    Effect.flatMap(({ buffer }) => Effect.forEach(buffer, write, { discard: true })),
  );
  return { output, flush };
});
