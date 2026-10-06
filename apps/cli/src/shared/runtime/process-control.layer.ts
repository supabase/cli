import type { EventEmitter } from "node:events";
import process from "node:process";
import { Deferred, Effect, Exit, Layer, Predicate, type Scope } from "effect";

import { ProcessControl, type CliProcessSignal } from "./process-control.service.ts";

const defaultSignals: ReadonlyArray<CliProcessSignal> = ["SIGINT", "SIGTERM"];

/**
 * processControlLayer - Node process lifecycle wiring.
 *
 * This layer translates OS signals and shutdown events into Effect values so
 * command code can coordinate cancellation and exit behavior without touching
 * `process` directly.
 */
export const processControlLayer = Layer.sync(ProcessControl, () =>
  ProcessControl.of({
    awaitSignal: (signals = defaultSignals) =>
      Effect.callback<CliProcessSignal>((resume) => {
        const cleanup = () => {
          for (const signal of signals) {
            process.off(signal, listeners[signal]);
          }
        };

        const listeners = Object.fromEntries(
          signals.map((signal) => [
            signal,
            () => {
              cleanup();
              resume(Effect.succeed(signal));
            },
          ]),
        ) as Record<CliProcessSignal, () => void>;

        for (const signal of signals) {
          process.once(signal, listeners[signal]);
        }

        return Effect.sync(cleanup);
      }),
    // `awaitShutdown` also listens for stdin closure so piped invocations can terminate cleanly.
    awaitShutdown: Effect.callback<void>((resume) => {
      const onShutdown = () => {
        cleanup();
        resume(Effect.void);
      };

      const cleanup = () => {
        process.off("SIGTERM", onShutdown);
        process.off("SIGINT", onShutdown);
        process.stdin.off("end", onShutdown);
        process.stdin.off("close", onShutdown);
      };

      process.once("SIGTERM", onShutdown);
      process.once("SIGINT", onShutdown);
      if (process.stdin.readable) {
        process.stdin.resume();
        process.stdin.once("end", onShutdown);
        process.stdin.once("close", onShutdown);
      }

      return Effect.sync(cleanup);
    }),
    // No-op listener per signal for the scope's lifetime; see
    // `ProcessControlShape.holdSignals` for why.
    holdSignals: (signals) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const noop = () => {};
          for (const signal of signals) {
            process.on(signal, noop);
          }
          return noop;
        }),
        (noop) =>
          Effect.sync(() => {
            for (const signal of signals) {
              process.removeListener(signal, noop);
            }
          }),
      ).pipe(Effect.asVoid),
    exit: (code: number) => Effect.sync(() => process.exit(code)),
    setExitCode: (code: number) =>
      Effect.sync(() => {
        process.exitCode = code;
      }),
    getExitCode: Effect.sync(() => {
      const exitCode = process.exitCode;
      return typeof exitCode === "number" ? exitCode : undefined;
    }),
  }),
);

/**
 * processControlLayerUntil - `processControlLayer` whose `awaitSignal` also resolves, as SIGTERM,
 * once `stop` completes, for a command that runs its own shutdown on a signal.
 */
export const processControlLayerUntil = (stop: Effect.Effect<void>) =>
  Layer.effect(
    ProcessControl,
    Effect.gen(function* () {
      const control = yield* ProcessControl;
      return ProcessControl.of({
        ...control,
        awaitSignal: (signals) =>
          Effect.raceFirst(
            control.awaitSignal(signals),
            stop.pipe(Effect.as<CliProcessSignal>("SIGTERM")),
          ),
      });
    }),
  ).pipe(Layer.provide(processControlLayer));

/**
 * exitOnBrokenPipe - Exits with 141 (128 + SIGPIPE) on an EPIPE that no other `error` listener
 * handles, since Bun ignores SIGPIPE and later writes to the closed pipe never settle; other such
 * errors rethrow. The returned function removes it, for when `holdBrokenPipes` takes over.
 */
export function exitOnBrokenPipe(
  streams: ReadonlyArray<EventEmitter>,
  exit: (code: number) => void,
): () => void {
  const removers = streams.map((stream) => {
    const listener = (error: Error) => {
      if (stream.listenerCount("error") > 1) return;
      if (!isBrokenPipe(error)) throw error;
      exit(141);
    };
    stream.on("error", listener);
    return () => stream.off("error", listener);
  });
  return () => {
    for (const remove of removers) remove();
  };
}

/**
 * holdBrokenPipes - While the scope is open, an EPIPE on any of `streams` completes the returned
 * Deferred instead of ending the process, so the caller can stop the command, let its cleanup
 * finish, and then exit 141; other errors that nothing else handles still throw.
 */
export const holdBrokenPipes = (
  streams: ReadonlyArray<EventEmitter> = [process.stdout, process.stderr],
): Effect.Effect<Deferred.Deferred<void>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const closed = yield* Deferred.make<void>();
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        streams.map((stream) => {
          const listener = (error: Error) => {
            if (isBrokenPipe(error)) Deferred.doneUnsafe(closed, Exit.void);
            else if (stream.listenerCount("error") === 1) throw error;
          };
          stream.on("error", listener);
          return () => stream.off("error", listener);
        }),
      ),
      (removers) =>
        Effect.sync(() => {
          for (const remove of removers) remove();
        }),
    );
    return closed;
  });

/** Whether `error` is an EPIPE, i.e. the reader of the pipe is gone. */
export const isBrokenPipe = (error: unknown): boolean =>
  Predicate.hasProperty(error, "code") && error.code === "EPIPE";
