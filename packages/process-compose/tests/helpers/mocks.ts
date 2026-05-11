import { Deferred, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

interface SpawnRecord {
  command: string;
  args: ReadonlyArray<string>;
}

const encoder = new TextEncoder();

export function mockChildProcessSpawner(
  opts: {
    exitCode?: number;
    stdout?: string[];
    stderr?: string[];
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
          spawned.push(record);
          opts.onSpawn?.(record);

          const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          let running = true;

          yield* Effect.forkDetach(
            Effect.gen(function* () {
              yield* Effect.sleep("10 millis");
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
              Effect.sync(() => {
                killed.push(killOpts?.killSignal ?? "SIGTERM");
                running = false;
              }),
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
