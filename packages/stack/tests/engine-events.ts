import { Data, Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
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

const awaitPodmanContainerRemoved = Effect.fn("EngineEvents.awaitPodmanContainerRemoved")(
  (id: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const wait = yield* spawner.spawn(
          ChildProcess.make(
            testEngine,
            [...engineTarget.argv, "wait", "--condition", "removing", "--ignore", id],
            { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
          ),
        );
        const [stderr, code] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(wait.stderr)), wait.exitCode],
          { concurrency: "unbounded" },
        );
        if (Number(code) !== 0)
          return yield* new EngineEventsError({ message: `podman wait failed: ${stderr}` });
      }),
    ),
);

/**
 * Completes once the engine has removed the container, including a removal that finished before
 * the call. Docker's event stream replays from `sinceSeconds` and names the event `destroy`.
 * Podman's file event logger drops unread events when it rotates the shared log, so Podman waits
 * on the container itself, which also returns for a container that no longer exists.
 */
export const awaitContainerRemoved = (id: string, sinceSeconds: number) =>
  testEngine === "podman"
    ? awaitPodmanContainerRemoved(id)
    : Effect.scoped(
        Effect.gen(function* () {
          const lines = yield* eventLines([
            "--since",
            String(sinceSeconds),
            "--filter",
            `container=${id}`,
            "--filter",
            "event=destroy",
            "--format",
            "{{.Actor.ID}}",
          ]);
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
