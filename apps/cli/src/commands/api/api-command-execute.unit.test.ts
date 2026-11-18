import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import * as Headers from "effect/http/Headers";
import * as TestClock from "effect/testing/TestClock";

import { pollSchedule, type PollOutcome } from "./api-command-execute.ts";

const outcome = (headers: Record<string, string> = {}): PollOutcome => ({
  done: false,
  response: { status: 200, bytes: new Uint8Array(), headers: Headers.fromInput(headers) },
});

/** Seconds, on the controlled clock, at which each of `reads` polls runs. */
const pollTimes = (reads: ReadonlyArray<PollOutcome>) =>
  Effect.gen(function* () {
    const clock = yield* TestClock.testClockWith(Effect.succeed);
    const times: Array<number> = [];
    const fiber = yield* Effect.sync(() => {
      const read = reads[Math.min(times.length, reads.length - 1)] ?? outcome();
      times.push(clock.currentTimeMillisUnsafe() / 1000);
      return read;
    }).pipe(
      Effect.repeat({ schedule: pollSchedule, times: reads.length - 1 }),
      Effect.forkChild({ startImmediately: true }),
    );
    for (let second = 0; second < 60; second += 1) yield* TestClock.adjust("1 second");
    yield* Fiber.join(fiber);
    return times;
  });

describe("poll schedule", () => {
  it.effect("backs off from 1s doubling to a 10s cap", () =>
    Effect.gen(function* () {
      const times = yield* pollTimes(Array.from({ length: 7 }, () => outcome()));
      expect(times).toEqual([0, 1, 3, 7, 15, 25, 35]);
    }),
  );

  it.effect("waits for a longer Retry-After given in seconds", () =>
    Effect.gen(function* () {
      const times = yield* pollTimes([outcome({ "retry-after": "5" }), outcome()]);
      expect(times).toEqual([0, 5]);
    }),
  );

  it.effect("honors the longest Retry-After across readiness reads", () =>
    Effect.gen(function* () {
      const times = yield* pollTimes([
        {
          ...outcome({ "retry-after": "2" }),
          responses: [outcome({ "retry-after": "6" }).response],
        },
        outcome(),
      ]);
      expect(times).toEqual([0, 6]);
    }),
  );

  it.effect("waits for a Retry-After given as an HTTP date", () =>
    Effect.gen(function* () {
      const date = "Thu, 01 Jan 1970 00:00:04 GMT";
      const times = yield* pollTimes([outcome({ "retry-after": date }), outcome()]);
      expect(times).toEqual([0, 4]);
    }),
  );

  it.effect("never waits less than the backoff for a shorter Retry-After", () =>
    Effect.gen(function* () {
      const times = yield* pollTimes([outcome({ "retry-after": "0" }), outcome()]);
      expect(times).toEqual([0, 1]);
    }),
  );
});
