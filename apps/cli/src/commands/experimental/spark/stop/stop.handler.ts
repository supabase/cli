import { Effect } from "effect";

import { Output } from "../../../../shared/output/output.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { deleteSparkProject, withPlatformApi } from "../spark-api.ts";
import { removeDevInstanceState, requireDevInstanceState } from "../spark-dev-instance.ts";

/**
 * `supabase stop` in dev-instance mode: the instance keeps running; with `--delete` the project
 * is deleted and the state file removed.
 */
export const sparkDevStop = Effect.fn("spark.stop")(function* (flags: {
  readonly delete: boolean;
}) {
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;
  yield* Effect.gen(function* () {
    const state = yield* requireDevInstanceState();
    if (!flags.delete)
      return yield* output.raw(
        `The dev instance ${state.name} (${state.ref}) keeps running. Delete it with \`supabase stop --delete\`.\n`,
      );
    const existed = yield* withPlatformApi(deleteSparkProject(state.ref));
    yield* Effect.annotateCurrentSpan({ "spark.dev_instance.existed": existed });
    yield* removeDevInstanceState();
    yield* output.raw(`Deleted the dev instance ${state.name} (${state.ref}).\n`);
  }).pipe(Effect.ensuring(telemetryState.flush));
});
