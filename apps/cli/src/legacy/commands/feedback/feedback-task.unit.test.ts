import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import { legacySettleFeedbackTask } from "./feedback-task.ts";

function recordingTask() {
  const settles: Array<"clear" | "fail"> = [];
  const task = {
    message: () => Effect.void,
    succeed: () => Effect.void,
    fail: () => Effect.sync(() => void settles.push("fail")),
    info: () => Effect.void,
    cancel: () => Effect.void,
    clear: () => Effect.sync(() => void settles.push("clear")),
  };
  return { task, settles };
}

describe("legacySettleFeedbackTask", () => {
  it.effect("clears the task when the wrapped effect succeeds", () => {
    const { task, settles } = recordingTask();
    return Effect.gen(function* () {
      const result = yield* Effect.succeed("ok").pipe(legacySettleFeedbackTask(task));

      expect(result).toBe("ok");
      expect(settles).toEqual(["clear"]);
    });
  });

  it.effect("marks the task failed on a typed failure", () => {
    const { task, settles } = recordingTask();
    return Effect.gen(function* () {
      const error = yield* Effect.fail("boom").pipe(legacySettleFeedbackTask(task), Effect.flip);

      expect(error).toBe("boom");
      expect(settles).toEqual(["fail"]);
    });
  });

  it.effect("clears the task when the fiber is interrupted mid-flight", () => {
    // The whole reason this helper exists: `tapError` + a sequential `clear()`
    // both skip the interrupt path, leaving the spinner (or its pending start
    // timer) running while shutdown finalizers execute.
    const { task, settles } = recordingTask();
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const fiber = yield* Deferred.succeed(started, undefined).pipe(
        Effect.flatMap(() => Effect.never),
        legacySettleFeedbackTask(task),
        Effect.forkChild,
      );
      // Interrupt only once the wrapped effect is running, so the finalizer is installed.
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);

      expect(settles).toEqual(["clear"]);
    });
  });
});
