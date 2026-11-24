import { Effect, Struct } from "effect";

import { Output } from "../../../../../shared/output/output.service.ts";
import { TelemetryState } from "../../../../../telemetry/telemetry-state.service.ts";
import { applyPendingMigrations, runSeedFiles } from "../../spark-apply.ts";
import {
  SparkDevInstanceError,
  withDevInstanceLock,
  writeDevInstanceState,
} from "../../spark-dev-instance.ts";
import { SparkTarget, withDevInstanceTarget } from "../../spark-target.ts";

const RESET_TIMEOUT_SECONDS = 60;

/**
 * The dev instance's reset: Spark empties it, then the migrations and seed files run again. The
 * state file records the seed as not run once the database is empty, until the seed succeeds, so
 * a failed reset seeds on `start`; a reset the API rejects leaves the database and the marker as
 * they were. The remote reset and the marker's clearing are one uninterruptible step. A reset
 * whose outcome is unknown (an interrupt or no answer within a minute) leaves `seeded` alone and
 * records `reset_pending`, which makes `start` and `db push` refuse until a `db reset` finishes.
 */
const resetDevInstance = withDevInstanceLock(
  withDevInstanceTarget((state) =>
    Effect.gen(function* () {
      const spark = yield* SparkTarget;
      const emptied = Struct.omit(state, ["reset_pending"]);
      const clearMarker = writeDevInstanceState({ ...emptied, seeded: false });
      const markPending = writeDevInstanceState({ ...state, reset_pending: true });
      yield* Effect.uninterruptibleMask((restore) =>
        restore(
          spark.resetDatabase.pipe(
            Effect.withSpan("spark.db.reset.remote"),
            Effect.timeoutOrElse({
              duration: `${RESET_TIMEOUT_SECONDS} seconds`,
              orElse: () =>
                Effect.andThen(
                  markPending,
                  new SparkDevInstanceError({
                    reason: "timeout",
                    message: `Resetting the dev instance ${state.ref} got no answer within ${RESET_TIMEOUT_SECONDS} seconds, so it may or may not have been emptied. Run \`supabase db reset\` again.`,
                  }),
                ),
            }),
            Effect.onInterrupt(() => Effect.ignore(markPending)),
          ),
        ).pipe(Effect.andThen(clearMarker)),
      );
      yield* applyPendingMigrations;
      yield* runSeedFiles();
      yield* writeDevInstanceState({ ...emptied, seeded: true });
    }),
  ),
);

/** `supabase db reset`: rebuilds the dev instance's database from migrations and seed files. */
export const sparkDbReset = Effect.gen(function* () {
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;
  yield* resetDevInstance.pipe(
    Effect.andThen(output.raw("Finished supabase db reset.\n")),
    Effect.ensuring(telemetryState.flush),
  );
}).pipe(Effect.withSpan("spark.db.reset"));
