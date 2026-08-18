import { Deferred, Effect, Layer, Sink, Stream } from "effect";
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
      "args" in config &&
      Array.isArray(config.args) &&
      ((config.command === "bash" && config.args[0] === "-c") ||
        ((config.command === "docker" || config.command === "podman") && config.args[0] === "exec"))
    );
  } catch {
    return false;
  }
};

export function mockChildProcessSpawner(
  opts: {
    exitCode?: number;
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
          const cmd = command._tag === "StandardCommand" ? command.command : "";
          const args = command._tag === "StandardCommand" ? command.args : [];
          const record: SpawnRecord = { command: cmd, args };
          yield* opts.beforeSpawn?.(record) ?? Effect.void;
          spawned.push(record);
          opts.onSpawn?.(record);

          const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          let running = true;

          yield* Effect.forkDetach(
            Effect.gen(function* () {
              // Supervisor processes model long-running services. Direct
              // commands model probes and one-shot helpers, which should
              // complete promptly.
              yield* Effect.sleep(
                cmd === process.execPath && !isOneShotSupervisor(args) ? "30 seconds" : "10 millis",
              );
              running = false;
              yield* Deferred.succeed(
                exitDeferred,
                ChildProcessSpawner.ExitCode(opts.exitCode ?? 0),
              );
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
