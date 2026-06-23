import { Duration, Effect, Random, Schedule } from "effect";

import { LegacyDebugFlag } from "../../../shared/legacy/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";

/**
 * `maxRetries` from Go's `utils.NewBackoffPolicy` (`internal/utils/retry.go:12`).
 * `backoff.WithMaxRetries(b, 8)` performs 8 retries -> 9 total attempts, matching
 * `Effect.retry({ schedule, times: 8 })`.
 */
export const LEGACY_BOOTSTRAP_MAX_RETRIES = 8;

const MAX_INTERVAL = Duration.seconds(60);

/**
 * Go-parity backoff for the api-keys and health retry loops
 * (`utils.NewBackoffPolicy` -> `cenkalti/backoff` `NewExponentialBackOff`):
 *
 *  - 3s initial interval, multiplier `1.5`
 *  - `MaxInterval` capped at 60s (applied to the base interval **before** jitter,
 *    matching cenkalti's order — so an individual delay can reach ~90s)
 *  - `RandomizationFactor` `0.5` -> each delay is jittered into `[0.5x, 1.5x]`
 *  - `MaxElapsedTime` 15m (intersected via `during`; in practice the 8-retry cap
 *    always trips first, but reproduced for completeness)
 */
export const legacyBootstrapBackoff: Schedule.Schedule<[Duration.Duration, Duration.Duration]> =
  Schedule.exponential("3 seconds", 1.5).pipe(
    Schedule.modifyDelay((_, delay) => Effect.succeed(Duration.min(delay, MAX_INTERVAL))),
    Schedule.modifyDelay((_, delay) =>
      Random.next.pipe(
        Effect.map((random) => Duration.millis(Duration.toMillis(delay) * (0.5 + random))),
      ),
    ),
    Schedule.both(Schedule.during("15 minutes")),
  );

/**
 * Reproduces Go's `utils.NewErrorCallback` (`internal/utils/retry.go:19-35`): after
 * each failed attempt it prints `<err>\nRetry (n/8): ` to a logger that starts as the
 * debug logger (discarded unless `--debug`) and switches to stderr once
 * `failureCount*3 > maxRetries` (i.e. from the 3rd failure on). Notify fires only for
 * attempts that will be retried, never the final exhausted one.
 *
 * Returns a fresh wrapper with its own failure counter per call, mirroring Go's
 * per-`RetryNotify` `NewErrorCallback()` + `policy.Reset()`.
 */
export const legacyBootstrapRetryNotify = () => {
  let failureCount = 0;
  return <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          failureCount += 1;
          // No notify on the final attempt (cenkalti returns `Stop` before notifying).
          if (failureCount > LEGACY_BOOTSTRAP_MAX_RETRIES) return;
          const toStderr = failureCount * 3 > LEGACY_BOOTSTRAP_MAX_RETRIES;
          const debug = yield* LegacyDebugFlag;
          // Failures 1-2 go to the debug logger (discarded unless `--debug`); 3+ to stderr.
          if (!toStderr && !debug) return;
          const output = yield* Output;
          const message = stringifyError(error);
          yield* output.raw(
            `${message}\nRetry (${failureCount}/${LEGACY_BOOTSTRAP_MAX_RETRIES}): `,
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
