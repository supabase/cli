import process from "node:process";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { ProcessControl } from "./process-control.service.ts";
import { processControlLayer } from "./process-control.layer.ts";

describe("ProcessControl", () => {
  it.effect("awaitSignal resolves when the requested signal is emitted", () =>
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const fiber = yield* processControl
        .awaitSignal(["SIGINT"])
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.sync(() => {
        process.emit("SIGINT");
      });
      const signal = yield* Fiber.join(fiber);
      expect(signal).toBe("SIGINT");
    }).pipe(Effect.provide(processControlLayer)),
  );
});
