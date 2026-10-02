import { Cause, Clock, Effect, Exit, Fiber, PubSub, Ref, Scope, Stream } from "effect";
import { failureMessage } from "../internal/failure-message.ts";
import { ServiceError, type RuntimeSession } from "../Service.ts";
import type { ContainerProcess } from "./Container.ts";

/** Wraps an arbitrary failure as a `ServiceError`, special-casing Effect timeouts for a clearer message. */
export const mapToServiceError = (operation: string, cause: unknown): ServiceError =>
  cause instanceof ServiceError
    ? cause
    : new ServiceError({
        operation,
        message: Cause.isTimeoutError(cause)
          ? `Service ${operation} timed out`
          : failureMessage(cause),
        cause,
      });

/** A descendant outside the process group can keep stderr open after the launcher exits. */
const stderrTailReady = (drained: Fiber.Fiber<void>) =>
  Fiber.await(drained).pipe(
    Effect.asVoid,
    Effect.raceFirst(Effect.sleep("1 second")),
    Effect.ignore,
  );

/**
 * Settles a runtime's exit as a `ServiceError` exit, optionally waiting briefly for a captured
 * stderr tail to drain and folding it into the failure message.
 */
export const processExit = <E extends { readonly message: string }>(
  exitCode: Effect.Effect<number, E>,
  describe: (code: number) => string,
  stderr?: {
    readonly tail: Ref.Ref<string>;
    readonly drained: Fiber.Fiber<void>;
  },
): Effect.Effect<Exit.Exit<void, ServiceError>> =>
  (stderr === undefined
    ? exitCode
    : exitCode.pipe(Effect.tap(() => stderrTailReady(stderr.drained)))
  ).pipe(
    Effect.flatMap((code) =>
      Number(code) === 0
        ? Effect.void
        : (stderr === undefined ? Effect.succeed("") : Ref.get(stderr.tail)).pipe(
            Effect.flatMap((text) => {
              const detail = text.trim();
              return Effect.fail(
                new ServiceError({
                  operation: "exit",
                  message:
                    detail.length === 0
                      ? describe(Number(code))
                      : `${describe(Number(code))}: ${detail}`,
                }),
              );
            }),
          ),
    ),
    Effect.mapError((cause) => mapToServiceError("exit", cause)),
    Effect.exit,
  );

/**
 * One output chunk of a launch, stamped with its publish time in epoch milliseconds. Each process
 * of the launch is a `part`; `seq` counts the launch's chunks per stream from zero across its
 * parts, so chunks dropped anywhere in the launch leave a gap.
 */
export interface LaunchOutput {
  readonly stream: "stdout" | "stderr";
  readonly bytes: Uint8Array;
  readonly launchId: number;
  readonly part: number;
  readonly seq: number;
  readonly time: number;
}

/** Publishes one chunk of a process's output. */
export type PublishOutput = (stream: "stdout" | "stderr", bytes: Uint8Array) => Effect.Effect<void>;

/** Tags a launch's output; each `part` call returns the publisher of the launch's next process. */
export const launchOutputPublisher = (
  logs: PubSub.PubSub<LaunchOutput>,
  launchId: number,
): Effect.Effect<{ readonly part: Effect.Effect<PublishOutput> }> =>
  Effect.gen(function* () {
    const parts = yield* Ref.make(0);
    const counters = yield* Ref.make<Readonly<Record<LaunchOutput["stream"], number>>>({
      stdout: 0,
      stderr: 0,
    });
    return {
      part: Ref.getAndUpdate(parts, (next) => next + 1).pipe(
        Effect.map(
          (part): PublishOutput =>
            (stream, bytes) =>
              Ref.modify(counters, (current) => [
                current[stream],
                { ...current, [stream]: current[stream] + 1 },
              ]).pipe(
                Effect.flatMap((seq) =>
                  Clock.currentTimeMillis.pipe(
                    Effect.flatMap((time) =>
                      PubSub.publish(logs, { stream, bytes, launchId, part, seq, time }),
                    ),
                  ),
                ),
                Effect.asVoid,
              ),
        ),
      ),
    };
  });

/**
 * Forks stdout/stderr drains that publish through `publish`; returns the stderr fiber so callers
 * can await drain completion (e.g. before finalizing exit). Optionally captures a rolling stderr
 * tail for folding into exit failure messages.
 */
export const publishProcessLogs = (
  process: {
    readonly stdout: Stream.Stream<Uint8Array, unknown>;
    readonly stderr: Stream.Stream<Uint8Array, unknown>;
  },
  publish: PublishOutput,
  scope: Scope.Closeable,
  stderrTail?: Ref.Ref<string>,
): Effect.Effect<Fiber.Fiber<void>> => {
  const drain = (stream: Stream.Stream<Uint8Array, unknown>, name: "stdout" | "stderr") => {
    const decoder = name === "stderr" && stderrTail !== undefined ? new TextDecoder() : undefined;
    const appendTail = (text: string) =>
      text.length === 0 || stderrTail === undefined
        ? Effect.void
        : Ref.update(stderrTail, (current) => (current + text).slice(-4096));
    return stream.pipe(
      Stream.runForEach((bytes) =>
        Effect.gen(function* () {
          if (decoder !== undefined) yield* appendTail(decoder.decode(bytes, { stream: true }));
          yield* publish(name, bytes);
        }),
      ),
      Effect.andThen(
        decoder === undefined
          ? Effect.void
          : Effect.sync(() => decoder.decode()).pipe(Effect.flatMap(appendTail)),
      ),
      Effect.catch((cause) => Effect.logError(cause)),
    );
  };
  return Effect.gen(function* () {
    yield* Effect.forkIn(drain(process.stdout, "stdout"), scope);
    return yield* Effect.forkIn(drain(process.stderr, "stderr"), scope);
  });
};

/** Wraps a container process into a `RuntimeSession`; `discard` is included only when requested. */
export const runtimeSessionFromContainer = (
  process: ContainerProcess,
  describeExit: (code: number) => string,
  options?: { readonly discard?: boolean },
): RuntimeSession => ({
  health: Effect.void,
  exit: processExit(process.exitCode, describeExit),
  stop: process.stop.pipe(Effect.mapError((cause) => mapToServiceError("stop", cause))),
  ...(options?.discard === true
    ? {
        discard: process.discard.pipe(Effect.mapError((cause) => mapToServiceError("stop", cause))),
      }
    : {}),
  remove: process.remove.pipe(Effect.mapError((cause) => mapToServiceError("remove", cause))),
});
