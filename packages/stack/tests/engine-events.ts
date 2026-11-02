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

/** Runs `podman wait` and resolves to its output, the container's exit code. */
const podmanWait = Effect.fn("EngineEvents.podmanWait")((args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const wait = yield* spawner.spawn(
        ChildProcess.make(testEngine, [...engineTarget.argv, "wait", ...args], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(wait.stdout)),
          Stream.mkString(Stream.decodeText(wait.stderr)),
          wait.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(code) !== 0)
        return yield* new EngineEventsError({ message: `podman wait failed: ${stderr}` });
      return stdout.trim();
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
    ? podmanWait(["--condition", "removing", "--ignore", id]).pipe(Effect.asVoid)
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
 * What a container stopped with SIGINT that exits cleanly reports. Docker's stop sends the signal
 * through the daemon, so its events show `kill` with the signal before `die`; Podman's stop signals
 * the container directly, so only its exit code is observable.
 */
export const cleanStopEvents: ReadonlyArray<string> =
  testEngine === "docker" ? ["kill 2", "die 0"] : ["exited 0"];

/**
 * Starts observing the container's stop and resolves, once it has exited, to what was observed.
 * Docker subscribes to its stop events from `since`, replaying any logged before the stream
 * attaches; subscribing before triggering the stop avoids Docker Desktop's intermittently empty
 * bounded replays. Podman's file event logger drops unread events when it rotates the shared log,
 * so Podman waits on the container's exit instead.
 */
export const observeContainerStop = Effect.fn("EngineEvents.observeContainerStop")(function* (
  container: string,
  since: string,
) {
  if (testEngine === "podman")
    return yield* podmanWait([container]).pipe(
      Effect.map((code): ReadonlyArray<string> => [`exited ${code}`]),
      Effect.forkScoped,
    );
  const lines = yield* eventLines([
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
  ]);
  return yield* lines.pipe(
    Stream.takeUntil((line) => line.startsWith("die ")),
    Stream.runCollect,
    Effect.forkScoped,
  );
});
