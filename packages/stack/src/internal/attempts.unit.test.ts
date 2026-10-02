import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schedule, Tracer } from "effect";
import { withAttemptCount } from "./attempts.ts";

const recordingTracer = Effect.sync(() => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer };
});

const failTwiceThenSucceed = Ref.make(0).pipe(
  Effect.map((calls) =>
    Ref.updateAndGet(calls, (value) => value + 1).pipe(
      Effect.flatMap((call) => (call < 3 ? Effect.fail("not ready") : Effect.succeed("ready"))),
      Effect.withSpan("probe"),
    ),
  ),
);

describe("withAttemptCount", () => {
  it.effect("records the attempt total on the wait span without a span per attempt", () =>
    Effect.gen(function* () {
      const { spans, tracer } = yield* recordingTracer;
      const probe = yield* failTwiceThenSucceed;

      const result = yield* withAttemptCount(probe, (counted) =>
        counted.pipe(Effect.retry(Schedule.recurs(5))),
      ).pipe(Effect.withSpan("wait"), Effect.withTracer(tracer), Effect.withTracerEnabled(true));

      expect(result).toBe("ready");
      expect(spans.map((span) => span.name)).toEqual(["wait"]);
      expect(spans[0]?.attributes.get("retry.attempt_count")).toBe(3);
    }),
  );

  it.effect("keeps attempt spans when the attempts are traced", () =>
    Effect.gen(function* () {
      const { spans, tracer } = yield* recordingTracer;
      const probe = yield* failTwiceThenSucceed;

      yield* withAttemptCount(probe, (counted) => counted.pipe(Effect.retry(Schedule.recurs(5))), {
        traced: true,
      }).pipe(Effect.withSpan("wait"), Effect.withTracer(tracer), Effect.withTracerEnabled(true));

      expect(spans.filter((span) => span.name === "probe")).toHaveLength(3);
    }),
  );
});
