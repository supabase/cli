import { expect } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import { discover, type StackLocations } from "../src/effect.ts";
import { HostProcessError } from "../src/HostProcess.ts";

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
