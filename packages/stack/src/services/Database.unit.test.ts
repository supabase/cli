import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option, Ref } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { nativePostgresRootError, processExit } from "./Database.ts";

it("refuses native PostgreSQL for uid 0 and allows every other runtime", () => {
  expect(nativePostgresRootError("native", 0)).toBe("PostgreSQL cannot be run as root");
  expect(nativePostgresRootError("native", 501)).toBeUndefined();
  expect(nativePostgresRootError("native", undefined)).toBeUndefined();
  expect(nativePostgresRootError("docker", 0)).toBeUndefined();
  expect(nativePostgresRootError("podman", 0)).toBeUndefined();
});

it.effect("waits for the stderr tail after a long-running native PostgreSQL exits", () =>
  Effect.gen(function* () {
    const tail = yield* Ref.make("");
    const drained = yield* Effect.forkChild(
      Effect.sleep("2500 millis").pipe(Effect.andThen(Ref.set(tail, "FATAL: data directory"))),
    );
    const settled = yield* Effect.forkChild(
      processExit(Effect.sleep("2 seconds").pipe(Effect.as(1)), { tail, drained }),
    );
    yield* TestClock.adjust("3 seconds");
    const exit = yield* Fiber.join(settled);
    const error = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined;
    expect(error?.message).toBe("PostgreSQL exited with code 1: FATAL: data directory");
  }),
);
