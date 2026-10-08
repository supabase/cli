import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, FileSystem, Layer, Schema, Sink, Stream } from "effect";
import { cleanupDockerRoot } from "./docker-cleanup.ts";
import { testEngine } from "./test-engine.ts";

/**
 * Runs a command of the selected test engine's CLI and returns its combined output and exit code.
 * It does not pin the engine target, so it works before an engine is known to be reachable.
 */
export const runEngine = Effect.fn("DockerTest.runEngine")((args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(testEngine, args, { stdout: "pipe", stderr: "pipe" }),
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

/** A container of an `engineStub` engine, labelled with its stack id and data root. */
export interface StubContainer {
  readonly id: string;
  readonly stackId: string;
  readonly root: string;
}

const encodeLabels = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);

/** The connection options `resolveEngineTarget` pins in front of a subcommand. */
const TARGET_OPTIONS = ["--context", "--host", "--url", "--connection"];

/**
 * Docker and Podman engines that each start with `containers`. Both answer the commands
 * `resolveEngineTarget` runs; a target's connection options are not part of a command's subcommand.
 * `ps --format` prints their labels as JSON lines, then every string entry as is; `ps --quiet`
 * prints the ids of those matching every `--filter`; `rm --force <id>` removes one. A command fails
 * with the given stderr when `failures` names its engine (`docker`) or its engine and subcommand
 * (`podman rm`). Every command is recorded and passed to `onCommand` before it is answered;
 * `remaining` lists an engine's containers.
 */
export const engineStub = (
  containers: ReadonlyArray<StubContainer | string>,
  failures: Readonly<Record<string, string>> = {},
  onCommand: (command: ReadonlyArray<string>) => Effect.Effect<void> = () => Effect.void,
) => {
  const commands: Array<ReadonlyArray<string>> = [];
  const noise = containers.filter((entry) => typeof entry === "string");
  const initial = containers.filter((entry) => typeof entry !== "string");
  const inventories = new Map(["docker", "podman"].map((engine) => [engine, initial]));
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command))
        return yield* Effect.die("Unexpected child process command");
      const argv = [command.command, ...command.args];
      commands.push(argv);
      const args = TARGET_OPTIONS.includes(command.args[0] ?? "")
        ? command.args.slice(2)
        : command.args;
      const [subcommand] = args;
      const failure = failures[`${command.command} ${subcommand}`] ?? failures[command.command];
      const inventory = inventories.get(command.command) ?? [];
      const filters = command.args.filter((_, index) => command.args[index - 1] === "--filter");
      const listed = inventory.filter((container) =>
        filters.every((filter) =>
          [
            `id=${container.id}`,
            "label=com.supabase.stack",
            `label=com.supabase.stack=${container.stackId}`,
            `label=com.supabase.stack-root=${container.root}`,
          ].includes(filter),
        ),
      );
      const listing = Effect.gen(function* () {
        if (!command.args.includes("--format")) return listed.map(({ id }) => id).join("\n");
        const labels = yield* Effect.forEach(listed, ({ stackId, root }) =>
          encodeLabels([stackId, root]).pipe(Effect.orDie),
        );
        return [...labels, ...noise].join("\n");
      });
      const identity =
        command.command === "podman" ? "false|false|stub-host|/stub/graph" : "stub-id";
      const stdout =
        failure !== undefined
          ? ""
          : subcommand === "context"
            ? "stub-context"
            : subcommand === "info"
              ? identity
              : subcommand === "ps"
                ? yield* listing
                : "";
      if (failure === undefined && subcommand === "rm")
        inventories.set(
          command.command,
          inventory.filter(({ id }) => id !== command.args.at(-1)),
        );
      yield* onCommand(argv);
      return ChildProcessSpawner.makeHandle({
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
      });
    }),
  );
  return {
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    commands,
    remaining: (engine: "docker" | "podman") => inventories.get(engine) ?? [],
  };
};
