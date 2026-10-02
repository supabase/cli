import { Deferred, Effect, Layer, PlatformError, Predicate, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

interface SpawnRecord {
  command: string;
  args: ReadonlyArray<string>;
}

const encoder = new TextEncoder();

const isOneShotSupervisor = (args: ReadonlyArray<string>): boolean => {
  const encoded = args.at(-1);
  if (encoded === undefined) return false;
  try {
    const config: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return (
      typeof config === "object" &&
      config !== null &&
      "command" in config &&
      config.command === "bash" &&
      "args" in config &&
      Array.isArray(config.args) &&
      config.args[0] === "-c"
    );
  } catch {
    return false;
  }
};

export function mockChildProcessSpawner(
  opts: {
    exitCode?: number | ((record: SpawnRecord) => number);
    stdout?: string[];
    stderr?: string[];
    beforeSpawn?: (record: SpawnRecord) => Effect.Effect<void>;
    onSpawn?: (record: SpawnRecord) => void;
  } = {},
) {
  const spawned: SpawnRecord[] = [];
  const killed: string[] = [];

  return {
    layer: Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const cmd = Predicate.isTagged(command, "StandardCommand") ? command.command : "";
          const args = Predicate.isTagged(command, "StandardCommand") ? command.args : [];
          const record: SpawnRecord = { command: cmd, args };
          yield* opts.beforeSpawn?.(record) ?? Effect.void;
          spawned.push(record);
          opts.onSpawn?.(record);

          const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          let running = true;

          yield* Effect.forkScoped(
            Effect.gen(function* () {
              // Supervisor processes model long-running services. Direct
              // commands model probes and one-shot helpers, which should
              // complete promptly.
              yield* Effect.sleep(
                cmd === process.execPath && !isOneShotSupervisor(args) ? "30 seconds" : "10 millis",
              );
              running = false;
              const resolvedExitCode =
                typeof opts.exitCode === "function" ? opts.exitCode(record) : (opts.exitCode ?? 0);
              yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(resolvedExitCode));
            }),
          );

          const stdoutBytes = (opts.stdout ?? []).map((line) => encoder.encode(`${line}\n`));
          const stderrBytes = (opts.stderr ?? []).map((line) => encoder.encode(`${line}\n`));

          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1000 + spawned.length),
            stdout: Stream.fromIterable(stdoutBytes),
            stderr: Stream.fromIterable(stderrBytes),
            all: Stream.empty,
            exitCode: Deferred.await(exitDeferred),
            isRunning: Effect.sync(() => running),
            stdin: Sink.drain,
            kill: (killOpts) =>
              Effect.gen(function* () {
                killed.push(killOpts?.killSignal ?? "SIGTERM");
                running = false;
                yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(143));
              }),
            unref: Effect.succeed(Effect.void),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
    get spawned() {
      return spawned;
    },
    get killed() {
      return killed;
    },
  };
}

/** How a host's container engine answers: absent from PATH, installed with its daemon down, or serving. */
export type ContainerEngineState = "missing" | "stopped" | "running";

/**
 * Spawner for a host whose `docker` and `podman` commands behave as `engines` describe. Other
 * commands fail with `NotFound`, or run on the real spawner through `hidingLayer`.
 */
export function containerEngineSpawner(engines: {
  readonly docker: ContainerEngineState;
  readonly podman: ContainerEngineState;
}) {
  const spawned: SpawnRecord[] = [];
  const notFound = (command: string) =>
    PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      pathOrDescriptor: command,
    });
  const spawner = (delegate?: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
    ChildProcessSpawner.make((command) => {
      const cmd = Predicate.isTagged(command, "StandardCommand") ? command.command : "";
      const args = Predicate.isTagged(command, "StandardCommand") ? command.args : [];
      if (cmd !== "docker" && cmd !== "podman")
        return delegate === undefined ? Effect.fail(notFound(cmd)) : delegate.spawn(command);
      spawned.push({ command: cmd, args });
      const state = engines[cmd];
      if (state === "missing") return Effect.fail(notFound(cmd));
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(2000 + spawned.length),
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(state === "running" ? 0 : 1)),
          isRunning: Effect.succeed(false),
          stdin: Sink.drain,
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
  return {
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner()),
    /** Wraps the provided real spawner so only the container engine commands are faked. */
    hidingLayer: Layer.effect(
      ChildProcessSpawner.ChildProcessSpawner,
      Effect.gen(function* () {
        return spawner(yield* ChildProcessSpawner.ChildProcessSpawner);
      }),
    ),
    get spawned() {
      return spawned;
    },
  };
}
