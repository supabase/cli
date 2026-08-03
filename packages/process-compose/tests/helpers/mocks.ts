import { Deferred, Effect, Layer, Sink, Stream } from "effect";
import { writeFileSync } from "node:fs";
import { ChildProcessSpawner } from "effect/unstable/process";

interface SpawnRecord {
  command: string;
  args: ReadonlyArray<string>;
}

const encoder = new TextEncoder();

const signalSupervisorSpawnGate = (args: ReadonlyArray<string>): void => {
  const encoded = args.at(-1);
  if (encoded === undefined) return;
  try {
    const config: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (typeof config !== "object" || config === null || !("spawnGate" in config)) return;
    const gate = config.spawnGate;
    if (
      typeof gate === "object" &&
      gate !== null &&
      "requestPath" in gate &&
      typeof gate.requestPath === "string"
    ) {
      writeFileSync(gate.requestPath, "ready", { flag: "wx" });
    }
  } catch {}
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
          signalSupervisorSpawnGate(args);
          yield* opts.beforeSpawn?.(record) ?? Effect.void;
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
