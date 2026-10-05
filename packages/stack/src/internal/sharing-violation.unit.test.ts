import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, PlatformError } from "effect";
import { TestClock } from "effect/testing";
import { LogStoreError } from "../host/LogStore.ts";
import { retrySharingViolation } from "./sharing-violation.ts";

const wrappedBusy = new LogStoreError({
  operation: "list",
  message: "resource busy",
  cause: PlatformError.systemError({
    _tag: "Busy",
    module: "FileSystem",
    method: "readDirectory",
    cause: Object.assign(new Error("resource busy"), { code: "EBUSY" }),
  }),
});

/** Fails with `wrappedBusy` on its first `failures` attempts. */
const flaky = (failures: number) => {
  let attempts = 0;
  return {
    attempts: () => attempts,
    effect: Effect.suspend(() =>
      attempts++ < failures ? Effect.fail(wrappedBusy) : Effect.succeed("listed"),
    ),
  };
};

describe("retrySharingViolation", () => {
  it.effect("retries a sharing violation wrapped in another error on Windows", () =>
    Effect.gen(function* () {
      const operation = flaky(2);

      const fiber = yield* operation.effect.pipe(retrySharingViolation("win32"), Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(fiber);

      expect(result).toBe("listed");
      expect(operation.attempts()).toBe(3);
    }),
  );

  it.effect("fails a wrapped sharing violation at once on other platforms", () =>
    Effect.gen(function* () {
      const operation = flaky(1);

      const error = yield* operation.effect.pipe(retrySharingViolation("linux"), Effect.flip);

      expect(error).toBe(wrappedBusy);
      expect(operation.attempts()).toBe(1);
    }),
  );
});
