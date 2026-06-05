import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Pull, Schedule } from "effect";

import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { LegacyDebugFlag } from "../../../shared/legacy/global-flags.ts";
import { legacyBootstrapBackoff, legacyBootstrapRetryNotify } from "./bootstrap.retry.ts";

// Drive the schedule's step function directly (no real sleeping): each call returns the
// next delay, and we feed an artificial `now` advanced by that delay so the `during`
// (max-elapsed) gate sees virtual time pass.
const collectDelays = (maxAttempts: number) =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(legacyBootstrapBackoff);
    const delays: Array<number> = [];
    let now = 0;
    let stopped = false;
    for (let i = 0; i < maxAttempts; i++) {
      const result = yield* step(now, undefined).pipe(
        Effect.map((output) => ({ kind: "delay" as const, delay: output[1] })),
        Pull.catchDone(() => Effect.succeed({ kind: "done" as const })),
      );
      if (result.kind === "done") {
        stopped = true;
        break;
      }
      const ms = Duration.toMillis(result.delay);
      delays.push(ms);
      now += ms;
    }
    return { delays, stopped };
  });

describe("legacyBootstrapBackoff", () => {
  it.effect("caps each delay at the 60s max interval (plus 50% jitter)", () =>
    Effect.gen(function* () {
      const { delays } = yield* collectDelays(40);
      // 60s `MaxInterval` capped before jitter, then jittered up to 1.5x => 90s ceiling.
      // Without the cap, the exponential base alone would exceed 90s within ~9 attempts.
      for (const ms of delays) {
        expect(ms).toBeGreaterThan(0);
        expect(ms).toBeLessThanOrEqual(90_000);
      }
    }),
  );

  it.effect("jitters the 3s initial interval into [1.5s, 4.5s]", () =>
    Effect.gen(function* () {
      const { delays } = yield* collectDelays(1);
      expect(delays[0]).toBeGreaterThanOrEqual(1_500);
      expect(delays[0]).toBeLessThanOrEqual(4_500);
    }),
  );

  it.effect("stops at the 15m max-elapsed cap, independent of the 8-retry limit", () =>
    Effect.gen(function* () {
      const { delays, stopped } = yield* collectDelays(60);
      // The schedule itself is bounded by elapsed time (15m), not the `times: 8` the
      // handler layers on, so it yields more than 8 delays before halting.
      expect(stopped).toBe(true);
      expect(delays.length).toBeGreaterThan(8);
    }),
  );
});

const BOOM = new Error("boom");

// Always-failing effect retried 8 times (9 attempts) to exercise the notify routing.
const runNotify = (opts: { debug: boolean; error?: unknown }) => {
  const out = mockOutput({ format: "text" });
  const notify = legacyBootstrapRetryNotify();
  const program = Effect.fail(opts.error ?? BOOM).pipe(
    notify,
    Effect.retry({ times: 8 }),
    Effect.exit,
  );
  return Effect.gen(function* () {
    yield* program;
    return out;
  }).pipe(Effect.provide(Layer.mergeAll(out.layer, Layer.succeed(LegacyDebugFlag, opts.debug))));
};

describe("legacyBootstrapRetryNotify", () => {
  it.effect("routes failures 1-2 to the debug logger (suppressed without --debug)", () =>
    Effect.gen(function* () {
      const out = yield* runNotify({ debug: false });
      // Failures 1-2 are debug-only; with --debug unset they must not reach stderr.
      expect(out.stderrText).not.toContain("Retry (1/8): ");
      expect(out.stderrText).not.toContain("Retry (2/8): ");
      // Failures 3+ always print to stderr, preceded by the error message.
      expect(out.stderrText).toContain("boom\nRetry (3/8): ");
      expect(out.stderrText).toContain("Retry (8/8): ");
    }),
  );

  it.effect("prints every notice to stderr under --debug", () =>
    Effect.gen(function* () {
      const out = yield* runNotify({ debug: true });
      expect(out.stderrText).toContain("boom\nRetry (1/8): ");
      expect(out.stderrText).toContain("Retry (2/8): ");
      expect(out.stderrText).toContain("Retry (8/8): ");
    }),
  );

  it.effect("emits no notice on the final exhausted attempt", () =>
    Effect.gen(function* () {
      const out = yield* runNotify({ debug: true });
      // 8 retries => 9 attempts, but cenkalti returns Stop before notifying the last one.
      expect(out.stderrText).not.toContain("Retry (9/8): ");
    }),
  );

  it.effect("stringifies a non-Error failure value", () =>
    Effect.gen(function* () {
      const out = yield* runNotify({ debug: true, error: "plain string failure" });
      expect(out.stderrText).toContain("plain string failure\nRetry (1/8): ");
    }),
  );

  it.effect("falls back to String() when the failure has a non-string message", () =>
    Effect.gen(function* () {
      const out = yield* runNotify({ debug: true, error: { message: 123 } });
      expect(out.stderrText).toContain("[object Object]\nRetry (1/8): ");
    }),
  );
});
