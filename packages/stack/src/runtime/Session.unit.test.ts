import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option, Ref } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { mapToServiceError, processExit } from "./Session.ts";

const describeExit = (code: number) => `runtime exited with code ${code}`;

describe("mapToServiceError", () => {
  it("names an error whose cause carries no message", () => {
    const failure = mapToServiceError("stop", new Cause.UnknownError(undefined));

    expect(failure.message).toBe("UnknownError");
  });

  it("describes a wrapped error without a message by its cause", () => {
    const cause = new Cause.UnknownError(new Error("container is gone"));
    const failure = mapToServiceError("stop", cause);

    expect(failure.message).toBe("container is gone");
  });
});

it.effect("waits for the stderr tail after a long-running runtime exits", () =>
  Effect.gen(function* () {
    const tail = yield* Ref.make("");
    const drained = yield* Effect.forkChild(
      Effect.sleep("2500 millis").pipe(Effect.andThen(Ref.set(tail, "FATAL: data directory"))),
    );
    const settled = yield* Effect.forkChild(
      processExit(Effect.sleep("2 seconds").pipe(Effect.as(1)), describeExit, { tail, drained }),
    );
    yield* TestClock.adjust("3 seconds");
    const exit = yield* Fiber.join(settled);
    const error = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined;
    expect(error?.message).toBe("runtime exited with code 1: FATAL: data directory");
  }),
);
