import { expect } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Predicate, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { fileURLToPath } from "node:url";
import { discover, type StackLocations } from "../src/effect.ts";
import { HostProcessError, shutdownHost, type HostAccess } from "../src/HostProcess.ts";

/** Requests shutdown through the owner's stable endpoint, failing with the owner's refusal. */
export const shutdownOwner = Effect.fn("Test.shutdownOwner")(function* (
  access: HostAccess,
  destroy: boolean,
) {
  const refusal = yield* shutdownHost(access, destroy);
  if (Option.isSome(refusal)) return yield* Effect.fail(refusal.value);
});

const leaseWaiter = fileURLToPath(new URL("./lease-wait-fixture.ts", import.meta.url));

/**
 * Starts waiting on a stack's lease file and returns an effect that completes once its current
 * holder releases it; call it before triggering the release.
 */
export const watchLeaseRelease = Effect.fn("Test.watchLeaseRelease")(function* (
  stateRoot: string,
  id: string,
) {
  const waiter = yield* ChildProcess.make(
    process.execPath,
    [leaseWaiter, `${stateRoot}/${id}/owner.lock`],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const waiting = yield* Deferred.make<void>();
  const stderr = yield* Stream.decodeText(waiter.stderr).pipe(Stream.mkString, Effect.forkScoped);
  const lines = yield* Stream.decodeText(waiter.stdout).pipe(
    Stream.splitLines,
    Stream.tap((line) => (line === "waiting" ? Deferred.succeed(waiting, undefined) : Effect.void)),
    Stream.runCollect,
    Effect.forkScoped,
  );
  const fail = (message: string) =>
    Fiber.join(stderr).pipe(
      Effect.flatMap((diagnostics) =>
        Effect.fail(
          new HostProcessError({ operation: "test-lease", message: `${message}: ${diagnostics}` }),
        ),
      ),
    );
  const output = Fiber.join(lines).pipe(Effect.map((collected) => Array.from(collected)));
  yield* Deferred.await(waiting).pipe(
    Effect.raceFirst(output.pipe(Effect.andThen(fail("Lease waiter did not open the lease")))),
  );
  return yield* Effect.succeed(
    output.pipe(
      Effect.flatMap((collected) =>
        collected.includes("free") ? Effect.void : fail("Lease waiter exited before the release"),
      ),
      Effect.timeoutOrElse({
        duration: "2 minutes",
        orElse: () => fail("The lease was not released"),
      }),
    ),
  );
});

export const captureOwnerPid = Effect.fn("Test.captureOwnerPid")(function* (
  locations: StackLocations,
  id: string,
) {
  const owner = (yield* discover(locations)).find((entry) => entry.definition.id === id)?.host;
  if (owner === undefined)
    return yield* new HostProcessError({ operation: "test-owner", message: `No owner for ${id}` });
  return owner.pid;
});

export const assertOwnerExited = Effect.fn("Test.assertOwnerExited")(function* (pid: number) {
  const exists = yield* Effect.try({
    try: () => process.kill(pid, 0),
    catch: (cause) =>
      new HostProcessError({ operation: "test-owner", message: String(cause), cause }),
  }).pipe(
    Effect.as(true),
    Effect.catchIf(
      ({ cause }) => Predicate.hasProperty(cause, "code") && cause.code === "ESRCH",
      () => Effect.succeed(false),
    ),
  );
  expect(exists, `Owner process ${pid} survived successful teardown`).toBe(false);
});
