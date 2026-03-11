import { Effect } from "effect";
import { ProcessControl } from "../../runtime/process-control.service.ts";

/**
 * Wait for a process-level shutdown signal (SIGTERM, SIGINT, or stdin close)
 * and complete successfully with a stop intent.
 *
 * This does NOT call stack.dispose() — the caller is responsible for
 * cleanup via Effect finalizers. This avoids double-disposal races while
 * keeping normal stop requests off the error path.
 */
export const interruptOnSignal: Effect.Effect<void, never, ProcessControl> = Effect.gen(
  function* () {
    const processControl = yield* ProcessControl;
    return yield* processControl.awaitShutdown;
  },
);
