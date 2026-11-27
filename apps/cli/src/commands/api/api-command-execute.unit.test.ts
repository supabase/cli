import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import * as Headers from "effect/http/Headers";
import * as TestClock from "effect/testing/TestClock";

import { pollSchedule, retryAfterMillis, type PollOutcome } from "./api-command-execute.ts";

const outcome = (): PollOutcome => ({
  _tag: "Read",
  done: false,
  response: { status: 200, bytes: new Uint8Array(), headers: Headers.empty },
});

const throttled = (retryAfter: number | undefined): PollOutcome => ({
  _tag: "Transient",
  detail: "HTTP 429",
  retryAfterMillis: retryAfter,
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

  it.effect("waits for a longer Retry-After after a throttled poll", () =>
    Effect.gen(function* () {
      const times = yield* pollTimes([throttled(5000), outcome()]);
      expect(times).toEqual([0, 5]);
    }),
  );

  it.effect("never waits less than the backoff for a shorter Retry-After", () =>
    Effect.gen(function* () {
      const times = yield* pollTimes([throttled(0), outcome()]);
      expect(times).toEqual([0, 1]);
    }),
  );
});

describe("Retry-After", () => {
  it.each([
    { name: "delta-seconds", value: "5", now: 0, millis: 5000 },
    { name: "an HTTP date", value: "Thu, 01 Jan 1970 00:00:04 GMT", now: 0, millis: 4000 },
    {
      name: "an HTTP date in the past",
      value: "Thu, 01 Jan 1970 00:00:04 GMT",
      now: 9000,
      millis: 0,
    },
    { name: "an unreadable value", value: "soon", now: 0, millis: undefined },
  ])("reads $name", ({ value, now, millis }) => {
    expect(retryAfterMillis(Headers.fromInput({ "retry-after": value }), now)).toBe(millis);
  });

  it("is absent without the header", () => {
    expect(retryAfterMillis(Headers.empty, 0)).toBeUndefined();
  });
});
