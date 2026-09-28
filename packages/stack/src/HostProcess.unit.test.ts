import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, PlatformError, Ref } from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  HostProcessError,
  type OwnerExitProbe,
  type OwnerExitProbeResult,
  ownerExitProbe,
  waitForOwnerExit,
} from "./HostProcess.ts";

const pending = (state: "present" | "inconclusive"): OwnerExitProbeResult =>
  state === "present" ? { state } : { state, code: "EPERM" };

it.effect("waits for the owner to disappear after an acknowledged shutdown", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const probe: OwnerExitProbe = () =>
      Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
        Effect.map((count) => (count === 0 ? pending("present") : { state: "absent" })),
      );
    const fiber = yield* waitForOwnerExit(123, probe).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("25 millis");
    yield* Fiber.join(fiber);
    expect(yield* Ref.get(attempts)).toBe(2);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("retries an inconclusive EPERM probe until the owner is absent", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const probe: OwnerExitProbe = () =>
      Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
        Effect.map((count) => (count < 2 ? pending("inconclusive") : { state: "absent" })),
      );
    const fiber = yield* waitForOwnerExit(123, probe).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("50 millis");
    yield* Fiber.join(fiber);
    expect(yield* Ref.get(attempts)).toBe(3);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("times out with the last present owner diagnostic", () =>
  Effect.gen(function* () {
    const probe: OwnerExitProbe = () => Effect.succeed(pending("present"));
    const fiber = yield* waitForOwnerExit(456, probe).pipe(Effect.flip, Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("6 seconds");
    const failure = yield* Fiber.join(fiber);
    expect(failure).toMatchObject({
      operation: "shutdown-exit",
      reason: "owner-exit-pending",
      message: "Owner shutdown acknowledgement completed, but process 456 is still running",
    });
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("times out with the last EPERM diagnostic", () =>
  Effect.gen(function* () {
    const probe: OwnerExitProbe = () => Effect.succeed(pending("inconclusive"));
    const fiber = yield* waitForOwnerExit(789, probe).pipe(Effect.flip, Effect.forkChild);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("6 seconds");
    const failure = yield* Fiber.join(fiber);
    expect(failure).toMatchObject({
      operation: "shutdown-exit",
      reason: "owner-exit-pending",
      message:
        "Owner shutdown acknowledgement completed, but process 789 is inaccessible (EPERM); exit is inconclusive",
    });
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("propagates unexpected probe errors without retrying", () =>
  Effect.gen(function* () {
    const failure = new HostProcessError({
      operation: "shutdown-exit",
      reason: "owner-exit-probe",
      message: "signal 0 failed with EINVAL",
    });
    const attempts = yield* Ref.make(0);
    const probe: OwnerExitProbe = () =>
      Ref.updateAndGet(attempts, (count) => count + 1).pipe(
        Effect.flatMap(() => Effect.fail(failure)),
      );
    const received = yield* waitForOwnerExit(321, probe).pipe(Effect.flip);
    expect(received).toBe(failure);
    expect(yield* Ref.get(attempts)).toBe(1);
  }),
);

it.effect("cancels the local owner wait", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const probe: OwnerExitProbe = () => Effect.succeed(pending("present"));
    const signalProbe: OwnerExitProbe = () =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(probe(654)));
    const fiber = yield* waitForOwnerExit(654, signalProbe).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("rejects an invalid owner PID before probing", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const probe: OwnerExitProbe = () =>
      Ref.updateAndGet(attempts, (count) => count + 1).pipe(
        Effect.as({ state: "absent" } as const),
      );
    const failure = yield* waitForOwnerExit(0, probe).pipe(Effect.flip);
    expect(failure).toMatchObject({
      operation: "shutdown-exit",
      reason: "invalid-owner-pid",
    });
    expect(yield* Ref.get(attempts)).toBe(0);
  }),
);

// The test process itself answers signal 0, so /proc content alone decides the result.
const statOf = (stat: string) =>
  FileSystem.makeNoop({ readFileString: () => Effect.succeed(stat) });

it.effect("treats a zombie or dead owner as exited on Linux", () =>
  Effect.gen(function* () {
    const probe = (stat: string) => ownerExitProbe(statOf(stat), "linux")(process.pid);
    expect(yield* probe(`${process.pid} (node) Z 1 1 1 0 -1 4194560`)).toEqual({ state: "absent" });
    expect(yield* probe(`${process.pid} (node) X 1 1 1 0 -1 4194560`)).toEqual({ state: "absent" });
    expect(yield* probe(`${process.pid} (my ) weird) proc) Z 1 1 1 0 -1 4194304`)).toEqual({
      state: "absent",
    });
    expect(yield* probe(`${process.pid} (node) S 1 1 1 0 -1 4194560`)).toEqual({
      state: "present",
    });
  }),
);

it.effect("keeps the signal result when /proc is unreadable or the platform is not Linux", () =>
  Effect.gen(function* () {
    const unreadable = FileSystem.makeNoop({
      readFileString: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "FileSystem",
            method: "readFileString",
            pathOrDescriptor: path,
          }),
        ),
    });
    expect(yield* ownerExitProbe(unreadable, "linux")(process.pid)).toEqual({ state: "present" });
    const zombie = statOf(`${process.pid} (node) Z 1 1 1 0 -1 4194560`);
    expect(yield* ownerExitProbe(zombie, "darwin")(process.pid)).toEqual({ state: "present" });
  }),
);
