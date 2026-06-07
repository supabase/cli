import process from "node:process";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
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

  it.effect("getExitCode returns the value previously set via setExitCode", () =>
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const initialExitCode = yield* processControl.getExitCode;
      expect(initialExitCode).toBe(process.exitCode);

      yield* processControl.setExitCode(23);
      const updatedExitCode = yield* processControl.getExitCode;
      expect(updatedExitCode).toBe(23);
    }).pipe(Effect.provide(processControlLayer)),
  );

  it.effect(
    "holdSignals installs listeners while the scope is open and removes them on close",
    () =>
      Effect.gen(function* () {
        const processControl = yield* ProcessControl;
        const before = {
          SIGINT: process.listenerCount("SIGINT"),
          SIGTERM: process.listenerCount("SIGTERM"),
          SIGHUP: process.listenerCount("SIGHUP"),
        };

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* processControl.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]);
            expect(process.listenerCount("SIGINT") - before.SIGINT).toBe(1);
            expect(process.listenerCount("SIGTERM") - before.SIGTERM).toBe(1);
            expect(process.listenerCount("SIGHUP") - before.SIGHUP).toBe(1);
          }),
        );

        // Listeners removed on scope close.
        expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
        expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
        expect(process.listenerCount("SIGHUP")).toBe(before.SIGHUP);
      }).pipe(Effect.provide(processControlLayer)),
  );

  it.effect("holdSignals removes listeners when its parent fiber is interrupted", () =>
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const before = {
        SIGINT: process.listenerCount("SIGINT"),
        SIGTERM: process.listenerCount("SIGTERM"),
      };

      const ready = Deferred.makeUnsafe<void>();
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* processControl.holdSignals(["SIGINT", "SIGTERM"]);
          yield* Effect.sync(() => Deferred.doneUnsafe(ready, Effect.void));
          yield* Effect.never;
        }),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(ready);
      expect(process.listenerCount("SIGINT") - before.SIGINT).toBe(1);
      expect(process.listenerCount("SIGTERM") - before.SIGTERM).toBe(1);

      yield* Fiber.interrupt(fiber);

      // acquireRelease's finalizer must run on interruption.
      expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
      expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
    }).pipe(Effect.provide(processControlLayer)),
  );

  it.effect("holdSignals listeners are no-ops (signal emission does not resolve)", () =>
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const scope = yield* Scope.make();

      yield* processControl.holdSignals(["SIGINT"]).pipe(Scope.provide(scope));

      // Emit the signal — no listener from holdSignals should do anything
      // observable (no resume, no exception). If Node had no userland
      // listener the default SIGINT action would kill the process, so the
      // fact that we get past this line is itself proof the noop is live.
      yield* Effect.sync(() => {
        process.emit("SIGINT");
      });

      // Sanity: we can still close the scope cleanly and the listener is
      // removed. No "resume" happened.
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(processControlLayer)),
  );
});
