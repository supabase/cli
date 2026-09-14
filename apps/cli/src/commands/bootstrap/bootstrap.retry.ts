import { Duration, Effect, Random, Schedule } from "effect";

import { DebugFlag } from "../../command-internal/global-flags.ts";
import { Output } from "../../shared/output/output.service.ts";

/** 8 retries (9 total attempts) via `Effect.retry({ schedule, times: 8 })`. */
export const BOOTSTRAP_MAX_RETRIES = 8;

const MAX_INTERVAL = Duration.seconds(60);

/**
 * Backoff for the api-keys and health retry loops:
 *
 *  - 3s initial interval, multiplier `1.5`
 *  - Capped at 60s before jitter is applied, so an individual delay can reach ~90s
 *  - Jittered into `[0.5x, 1.5x]` of the (possibly capped) interval
 *  - Bounded to 15 minutes total elapsed time, though the 8-retry cap always trips first
 */
export const bootstrapBackoff = Schedule.exponential("3 seconds", 1.5).pipe(
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, MAX_INTERVAL))),
  Schedule.modifyDelay(({ duration }) =>
    Random.next.pipe(
      Effect.map((random) => Duration.millis(Duration.toMillis(duration) * (0.5 + random))),
    ),
  ),
  Schedule.upTo({ duration: "15 minutes" }),
);

/**
 * After each failed attempt, prints `<err>\nRetry (n/8): ` to the debug logger (discarded unless
 * `--debug`) for the first two failures, then to stderr from the third on. Never fires for the
 * final, exhausted attempt.
 *
 * Returns a fresh wrapper with its own failure counter per call.
 */
export const bootstrapRetryNotify = () => {
  let failureCount = 0;
  return <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          failureCount += 1;
          // No notify on the final, exhausted attempt.
          if (failureCount > BOOTSTRAP_MAX_RETRIES) return;
          const toStderr = failureCount * 3 > BOOTSTRAP_MAX_RETRIES;
          const debug = yield* DebugFlag;
          // Failures 1-2 go to the debug logger (discarded unless `--debug`); 3+ to stderr.
          if (!toStderr && !debug) return;
          const output = yield* Output;
          const message = stringifyError(error);
          yield* output.raw(
            `${message}\nRetry (${failureCount}/${BOOTSTRAP_MAX_RETRIES}): `,
            "stderr",
          );
        }),
      ),
    );
};

function stringifyError(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}
