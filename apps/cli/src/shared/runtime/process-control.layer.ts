import process from "node:process";
import { Effect, Layer } from "effect";

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
    // `awaitSignal` is used for long-lived command interruption such as `start`.
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
    // `holdSignals` is the no-resume dual of `awaitSignal`. It installs a
    // no-op listener per signal for the lifetime of the caller's scope. The
    // only purpose is to suppress the runtime's default terminate-on-signal
    // behavior so a child process spawned with `detached:false` can receive
    // the signal via the shared process group and handle it itself, while
    // the parent waits for the child's real exit code instead of being
    // killed with 130 by Bun/Node's default action.
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
