import { Cause, Effect, Exit } from "effect";
import type { OutputTask } from "../../../shared/output/output.service.ts";

/**
 * Settles a spinner task on every exit of the wrapped effect: cleared on
 * success, marked failed on a typed failure, and cleared on interruption.
 * The common `tapError(fail)` + `clear()` pairing skips the interrupt path —
 * Ctrl-C would leave the delayed clack spinner (or its pending start timer)
 * running while the shutdown finalizers execute.
 */
export const legacySettleFeedbackTask =
  (task: OutputTask) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? task.clear()
          : Cause.hasInterruptsOnly(exit.cause)
            ? task.clear()
            : task.fail(),
      ),
    );
