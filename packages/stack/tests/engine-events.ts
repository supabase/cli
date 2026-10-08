import { Data, Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { engineTarget, testEngine } from "./engine-target.ts";

class EngineEventsError extends Data.TaggedError("EngineEventsError")<{
  readonly message: string;
}> {}

const eventLines = Effect.fn("EngineEvents.eventLines")((args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const events = yield* spawner.spawn(
      ChildProcess.make(testEngine, [...engineTarget.argv, "events", ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      }),
    );
    return events.stdout.pipe(Stream.decodeText, Stream.splitLines);
  }),
);

/**
 * Completes when the engine reports the container removed, including a removal that happened
 * after `sinceSeconds` and before the stream attached. Docker names that event `destroy`; Podman
 * names it `remove`.
 */
export const awaitContainerRemoved = (id: string, sinceSeconds: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const lines = yield* eventLines(
        testEngine === "docker"
          ? [
              "--since",
              String(sinceSeconds),
              "--filter",
              `container=${id}`,
              "--filter",
              "event=destroy",
              "--format",
              "{{.Actor.ID}}",
            ]
          : [
              "--since",
              String(sinceSeconds),
              "--filter",
              `container=${id}`,
              "--filter",
              "event=remove",
              "--format",
              "{{.ID}}",
            ],
      );
      const removed = yield* lines.pipe(
        Stream.filter((line) => line.trim() === id),
        Stream.runHead,
      );
      if (Option.isNone(removed))
        return yield* new EngineEventsError({ message: `${testEngine} event stream ended` });
    }),
  );

/**
 * What the engine reports for a container stopped with SIGINT that exits cleanly. Docker's stop
 * sends the signal through the daemon, so it reports `kill` with the signal before `die`; Podman's
 * stop signals the container directly and reports only `died` with the exit code.
 */
export const cleanStopEvents: ReadonlyArray<string> =
  testEngine === "docker" ? ["kill 2", "die 0"] : ["died 0"];

/**
 * Subscribes to the container's stop events from `since` (replaying any logged before the stream
 * attaches) and resolves, once its terminal event arrives, to every line observed. Subscribing
 * before triggering the stop avoids Docker Desktop's intermittently empty bounded replays.
 */
export const observeContainerStop = Effect.fn("EngineEvents.observeContainerStop")(function* (
  container: string,
  since: string,
) {
  const lines = yield* eventLines(
    testEngine === "docker"
      ? [
          "--since",
          since,
          "--filter",
          `container=${container}`,
          "--filter",
          "event=kill",
          "--filter",
          "event=die",
          "--format",
          '{{.Action}} {{index .Actor.Attributes "signal"}}{{index .Actor.Attributes "exitCode"}}',
        ]
      : [
          "--since",
          since,
          "--filter",
          `container=${container}`,
          "--filter",
          "event=died",
          "--format",
          "{{.Status}} {{.ContainerExitCode}}",
        ],
  );
  return yield* lines.pipe(
    Stream.takeUntil((line) => line.startsWith(testEngine === "docker" ? "die " : "died ")),
    Stream.runCollect,
    Effect.forkScoped,
  );
});
