import { Effect, Option } from "effect";

import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { findSparkProject, withPlatformApi } from "../spark-api.ts";
import {
  emitDevInstanceStatus,
  requireReadyDevInstanceState,
  SparkDevInstanceError,
} from "../spark-dev-instance.ts";

/** `supabase status`: the dev instance's status, URLs and keys. */
export const sparkDevStatus = Effect.fn("spark.status")(function* (flags: {
  readonly env: boolean;
}) {
  const telemetryState = yield* TelemetryState;
  yield* Effect.gen(function* () {
    const state = yield* requireReadyDevInstanceState();
    const project = yield* withPlatformApi(findSparkProject(state.ref));
    if (Option.isNone(project))
      return yield* new SparkDevInstanceError({
        reason: "missing",
        message: `The dev instance ${state.ref} no longer exists. Run \`supabase start\` to create a new one.`,
      });
    yield* emitDevInstanceStatus(state, project.value.status ?? "UNKNOWN", flags);
  }).pipe(Effect.ensuring(telemetryState.flush));
});
