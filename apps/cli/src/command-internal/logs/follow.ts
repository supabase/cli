import { Effect, Schedule } from "effect";
import { ProcessControl } from "../../shared/runtime/process-control.service.ts";

export const followLogs = Effect.fn("Logs.follow")(function* <A, E, R>(
  poll: Effect.Effect<A, E, R>,
  schedule: Schedule.Schedule<unknown>,
) {
  const processControl = yield* ProcessControl;
  yield* Effect.raceFirst(
    poll.pipe(Effect.repeat(schedule)),
    processControl
      .awaitSignal()
      .pipe(Effect.flatMap((signal) => processControl.setExitCode(signal === "SIGINT" ? 130 : 0))),
  );
});
