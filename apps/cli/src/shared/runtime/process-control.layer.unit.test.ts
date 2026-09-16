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

  it.effect("holdSignals remains installed after awaitSignal resolves", () =>
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const before = process.listenerCount("SIGINT");

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* processControl.holdSignals(["SIGINT"]);
          const fiber = yield* processControl
            .awaitSignal(["SIGINT"])
            .pipe(Effect.forkChild({ startImmediately: true }));

          expect(process.listenerCount("SIGINT") - before).toBe(2);
          yield* Effect.sync(() => {
            process.emit("SIGINT");
          });
          expect(yield* Fiber.join(fiber)).toBe("SIGINT");
          expect(process.listenerCount("SIGINT") - before).toBe(1);
        }),
      );

      expect(process.listenerCount("SIGINT")).toBe(before);
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

      expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
      expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
    }).pipe(Effect.provide(processControlLayer)),
  );

  it.effect("holdSignals listeners are no-ops (signal emission does not resolve)", () =>
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const scope = yield* Scope.make();

      yield* processControl.holdSignals(["SIGINT"]).pipe(Scope.provide(scope));

      // Reaching the next line without the process dying is itself the
      // assertion: with no listener, SIGINT's default action would exit.
      yield* Effect.sync(() => {
        process.emit("SIGINT");
      });

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(processControlLayer)),
  );
});
