import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, FileSystem, Layer, Sink, Stream } from "effect";
import { cleanupDockerRoot } from "./docker-cleanup.ts";

/** Runs a Docker CLI command and returns its combined output and exit code. */
export const runDocker = Effect.fn("DockerTest.runDocker")((args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("docker", args, { stdout: "pipe", stderr: "pipe" }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { output: `${stdout}${stderr}`, code: Number(code) };
    }),
  ),
);

/**
 * Allocates the documented state-root layout used by Docker database fixtures. The volume this
 * state root's Docker database creates is removed by the `SUPABASE_STACK_TEST_RUN` test-run
 * cleanup (see `tests/docker-volume-run.ts`), not by this fixture.
 */
export const makeDockerDatabaseRoot = Effect.fn("DockerTest.makeDatabaseRoot")(
  (prefix: string, stackId = "catalog-test") =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temporaryRoot = yield* fs.makeTempDirectoryScoped({ prefix });
      const root = `${temporaryRoot}/state/${stackId}/data`;
      yield* fs.makeDirectory(root, { recursive: true });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (yield* fs.exists(root)) yield* cleanupDockerRoot(root);
        }).pipe(Effect.catchCause(Effect.die)),
      );
      return root;
    }),
);

/**
 * A container engine whose `ps --format` prints `listing`, and whose commands fail with the given
 * stderr for an engine named in `failures`; it records every command it runs.
 */
export const engineStub = (listing: string, failures: Readonly<Record<string, string>> = {}) => {
  const commands: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command))
      return Effect.die("Unexpected child process command");
    commands.push([command.command, ...command.args]);
    const failure = failures[command.command];
    const stdout = failure === undefined && command.args.includes("--format") ? listing : "";
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(failure === undefined ? 0 : 1)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.succeed(new TextEncoder().encode(stdout)),
        stderr:
          failure === undefined ? Stream.empty : Stream.succeed(new TextEncoder().encode(failure)),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    );
  });
  return { layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner), commands };
};
