import { Effect } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { deleteSparkProject, withPlatformApi } from "../spark-api.ts";
import {
  removeDevInstanceState,
  requireDevInstanceState,
  withDevInstanceLock,
} from "../spark-dev-instance.ts";

/**
 * `supabase stop`: the dev instance keeps running; with `--delete` the project
 * is deleted and the state file removed.
 */
export const sparkDevStop = Effect.fn("spark.stop")(function* (flags: {
  readonly delete: boolean;
}) {
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;
  yield* Effect.gen(function* () {
    if (!flags.delete) {
      const state = yield* requireDevInstanceState();
      return yield* output.raw(
        `The dev instance ${state.name} (${state.ref}) keeps running. Delete it with \`supabase stop --delete\`.\n`,
      );
    }
    // Read under the lock, so a `start` that replaced the project meanwhile is seen.
    const state = yield* withDevInstanceLock(
      Effect.gen(function* () {
        const recorded = yield* requireDevInstanceState();
        const existed = yield* withPlatformApi(deleteSparkProject(recorded.ref));
        yield* Effect.annotateCurrentSpan({ "spark.dev_instance.existed": existed });
        yield* removeDevInstanceState();
        return recorded;
      }),
    );
    yield* output.raw(`Deleted the dev instance ${state.name} (${state.ref}).\n`);
  }).pipe(Effect.ensuring(telemetryState.flush));
});
