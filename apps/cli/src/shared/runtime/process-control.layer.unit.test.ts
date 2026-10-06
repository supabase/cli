import process from "node:process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { ProcessControl } from "./process-control.service.ts";
import {
  exitOnBrokenPipe,
  holdBrokenPipes,
  processControlLayer,
  processControlLayerUntil,
} from "./process-control.layer.ts";

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

  it.effect("awaitSignal also resolves, as SIGTERM, once a layer's stop effect completes", () =>
    Effect.gen(function* () {
      const stop = yield* Deferred.make<void>();
      const signal = yield* Effect.gen(function* () {
        const processControl = yield* ProcessControl;
        const fiber = yield* processControl
          .awaitSignal(["SIGINT"])
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(stop, undefined);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(processControlLayerUntil(Deferred.await(stop))));

      expect(signal).toBe("SIGTERM");
    }),
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
          return yield* Effect.never;
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

const writeError = (code: string) => Object.assign(new Error(`write ${code}`), { code });

describe("exitOnBrokenPipe", () => {
  const guardedStream = () => {
    const stream = new PassThrough();
    const exits: Array<number> = [];
    exitOnBrokenPipe([stream], (code) => exits.push(code));
    return { stream, exits };
  };

  it.effect("exits with 141 when nothing else handles an EPIPE on stdout or stderr", () =>
    Effect.sync(() => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const exits: Array<number> = [];
      exitOnBrokenPipe([stdout, stderr], (code) => exits.push(code));

      stdout.emit("error", writeError("EPIPE"));
      stderr.emit("error", writeError("EPIPE"));

      expect(exits).toEqual([141, 141]);
    }),
  );

  it.effect.each(["EPIPE", "ENOSPC"])("leaves %s to another error listener", (code) =>
    Effect.sync(() => {
      const { stream, exits } = guardedStream();
      const handled: Array<unknown> = [];
      stream.on("error", (error) => handled.push(error));
      const error = writeError(code);

      expect(() => stream.emit("error", error)).not.toThrow();
      expect(handled).toEqual([error]);
      expect(exits).toEqual([]);
    }),
  );

  it.effect("rethrows any other stream error that nothing else handles", () =>
    Effect.sync(() => {
      const { stream, exits } = guardedStream();
      const error = writeError("ENOSPC");

      expect(() => stream.emit("error", error)).toThrow(error);
      expect(exits).toEqual([]);
    }),
  );

  it.effect("stops handling the streams once removed", () =>
    Effect.sync(() => {
      const stream = new PassThrough();
      const remove = exitOnBrokenPipe([stream], () => {});

      remove();

      expect(stream.listenerCount("error")).toBe(0);
    }),
  );
});

describe("holdBrokenPipes", () => {
  it.effect("records an EPIPE on stdout or stderr instead of exiting, until its scope closes", () =>
    Effect.gen(function* () {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const closed = yield* Effect.scoped(
        Effect.gen(function* () {
          const closed = yield* holdBrokenPipes([stdout, stderr]);
          expect(yield* Deferred.isDone(closed)).toBe(false);
          yield* Effect.sync(() => stderr.emit("error", writeError("EPIPE")));
          return closed;
        }),
      );

      expect(yield* Deferred.isDone(closed)).toBe(true);
      expect([stdout.listenerCount("error"), stderr.listenerCount("error")]).toEqual([0, 0]);
    }),
  );

  it.effect("records an EPIPE that another error listener also handles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stream = new PassThrough();
        const closed = yield* holdBrokenPipes([stream]);
        const handled: Array<unknown> = [];
        stream.on("error", (error) => handled.push(error));
        const error = writeError("EPIPE");

        yield* Effect.sync(() => stream.emit("error", error));

        expect(handled).toEqual([error]);
        expect(yield* Deferred.isDone(closed)).toBe(true);
      }),
    ),
  );

  it.effect("rethrows any other stream error that nothing else handles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stream = new PassThrough();
        const closed = yield* holdBrokenPipes([stream]);
        const error = writeError("ENOSPC");

        expect(() => stream.emit("error", error)).toThrow(error);
        expect(yield* Deferred.isDone(closed)).toBe(false);
      }),
    ),
  );
});
