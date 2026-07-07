import { Deferred, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

interface SpawnRecord {
  command: string;
  args: ReadonlyArray<string>;
}

const encoder = new TextEncoder();

/**
 * Decode the supervisor payload (base64url JSON in the last arg — see
 * `makeSupervisedCommand`) to recover the underlying service command. Returns
 * `undefined` for non-supervised spawns (health-check probes, docker commands,
 * etc.) whose last arg is not a supervisor payload.
 */
function decodeSupervisedInnerCommand(args: ReadonlyArray<string>): string | undefined {
  const encoded = args.at(-1);
  if (encoded === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      command?: unknown;
    };
    return typeof decoded.command === "string" ? decoded.command : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a spawn models a long-running daemon (postgres, postgrest, …) that
 * stays alive until it is explicitly killed, versus a short-lived process
 * (health-check probes like `pg_isready`, one-shot init scripts, docker
 * commands) that exits on its own.
 *
 * This distinction is essential for fidelity to real processes. Real daemons do
 * NOT exit ~immediately after spawning; if the mock had them exit after a fixed
 * delay (as it once did), the orchestrator's `unless-stopped`/`always` restart
 * loop would treat every daemon as a crash-looping process and churn through
 * `RestartTriggered` → backoff → respawn cycles forever. That never happens in
 * production (daemons run until stopped), so the projected status would never
 * settle on Running/Healthy — an artifact that only the mock could produce.
 *
 * A supervised spawn (launched through `makeSupervisedCommand`, i.e. the
 * supervisor runtime with a base64url payload) is treated as a long-running
 * daemon UNLESS its inner command is a shell (`bash`/`sh`), which is how
 * one-shot init services like `postgres-init` (restart: "no") are launched —
 * those must still exit so their `completed` signal fires.
 */
function isLongRunningDaemon(args: ReadonlyArray<string>): boolean {
  const inner = decodeSupervisedInnerCommand(args);
  if (inner === undefined) return false;
  const base = inner.split("/").pop() ?? inner;
  return base !== "bash" && base !== "sh";
}

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

          const longRunning = isLongRunningDaemon(args);

          // Long-running daemons stay alive until killed (matching real processes);
          // short-lived processes (probes, one-shot init scripts, docker commands)
          // resolve their exit code after a real 10ms sleep so `it.live` clocks progress.
          if (!longRunning) {
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
          }

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
                // Resolve the exit code so callers awaiting it (the orchestrator's
                // restart/stop paths) unblock — a killed process reports 143 (128 + SIGTERM).
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
