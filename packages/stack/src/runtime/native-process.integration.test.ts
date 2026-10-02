import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Ref, Sink, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { NodeServices } from "@effect/platform-node";
import { systemError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerType } from "effect/unstable/process/ChildProcessSpawner";
import type { ExitCode } from "effect/unstable/process/ChildProcessSpawner";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The test closes inherited fd5 before sending the launch payload and scans exact marker-owned processes for cleanup.
import { execFileSync, spawn as spawnProcess } from "node:child_process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The test waits for actual inherited-fd and process events.
import { once } from "node:events";
import {
  defaultNativeProcessLauncher,
  spawnNativeProcess,
  type NativeProcess,
  type NativeProcessSpec,
} from "./NativeProcess.ts";

const targetPid = 87_035;

interface FakeProcessOptions {
  readonly groupOutput?: string;
  readonly groupExitCode?: number;
  readonly groupIdOutput?: string;
  readonly killCode?: "EPERM" | "ESRCH";
  readonly groupSpawnFailure?: boolean;
  readonly targetPid?: number;
  readonly delegatePsTo?: ChildProcessSpawnerType["Service"];
  readonly groupForeignSpawnDefect?: boolean;
  readonly groupStallReady?: Deferred.Deferred<void>;
  readonly groupStallClosed?: Deferred.Deferred<void>;
  readonly exitStarted?: Deferred.Deferred<void>;
  readonly exitCode?: Deferred.Deferred<ExitCode>;
}

const makeSpawner = (options: FakeProcessOptions) => {
  let stallConsumed = false;
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("unexpected piped command");
    if (command.command === "/bin/ps") {
      if (options.groupForeignSpawnDefect) return Effect.die(new Error("injected ps spawn defect"));
      if (options.delegatePsTo !== undefined) return options.delegatePsTo.spawn(command);
      const stallReady = options.groupStallReady;
      if (stallReady !== undefined && !stallConsumed) {
        stallConsumed = true;
        const stallClosed = options.groupStallClosed;
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(87_036),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.never,
          stderr: Stream.empty,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
        const acquired =
          stallClosed === undefined
            ? Effect.succeed(handle)
            : Effect.acquireRelease(Effect.succeed(handle), () =>
                Deferred.succeed(stallClosed, undefined),
              );
        return acquired.pipe(Effect.tap(() => Deferred.succeed(stallReady, undefined)));
      }
      if (options.groupSpawnFailure)
        return Effect.fail(
          systemError({
            _tag: "NotFound",
            module: "test",
            method: "spawn",
            description: "ps unavailable",
          }),
        );
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(87_036),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.groupExitCode ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout:
            options.groupOutput === undefined
              ? Stream.empty
              : Stream.succeed(new TextEncoder().encode(options.groupOutput)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      );
    }
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(options.targetPid ?? targetPid),
        exitCode: (() => {
          const exit = options.exitCode;
          return exit === undefined
            ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
            : Effect.gen(function* () {
                if (options.exitStarted !== undefined)
                  yield* Deferred.succeed(options.exitStarted, undefined);
                return yield* Deferred.await(exit);
              });
        })(),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: (fd) =>
          fd === 5
            ? Stream.succeed(
                new TextEncoder().encode(
                  options.groupIdOutput ?? `${options.targetPid ?? targetPid}\n`,
                ),
              )
            : Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    );
  });
  return spawner;
};

const spec: NativeProcessSpec = { executable: "test-native-process" };

const withMockedTargetKill = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  target: number,
  code: "EPERM" | "ESRCH" = "EPERM",
  failAlways = true,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const originalKill = globalThis.process.kill;
      let failed = false;
      globalThis.process.kill = (pid, signal) => {
        if (pid === -target) {
          if (!failAlways && failed)
            throw Object.assign(new Error("operation ESRCH"), { code: "ESRCH" });
          failed = true;
          throw Object.assign(new Error(`operation ${code}`), { code });
        }
        return originalKill(pid, signal);
      };
      return originalKill;
    }),
    () => effect,
    (originalKill) =>
      Effect.sync(() => {
        globalThis.process.kill = originalKill;
      }),
  );

const runKill = (options: FakeProcessOptions) => {
  const spawner = makeSpawner(options);
  const effect = Effect.scoped(
    Effect.gen(function* () {
      const native: NativeProcess = yield* spawnNativeProcess(spec, {
        command: "test-launcher",
        args: [],
      });
      const result = yield* native.kill.pipe(Effect.exit);
      return { result };
    }),
  ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  return withMockedTargetKill(effect, options.targetPid ?? targetPid, options.killCode, false);
};

interface ProcessProbeError {
  readonly code?: string;
}

const processProbeError = (cause: unknown): ProcessProbeError => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
  )
    return { code: cause.code };
  return {};
};

const assertExited = (pid: number) =>
  Effect.gen(function* () {
    const alive = yield* Effect.try({
      try: () => process.kill(pid, 0),
      catch: processProbeError,
    }).pipe(
      Effect.as(true),
      Effect.catchIf(
        ({ code }) => code === "ESRCH",
        () => Effect.succeed(false),
      ),
    );
    if (!alive) return true;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const probe = yield* ChildProcess.make("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        });
        const [output, exitCode] = yield* Effect.all(
          [probe.stdout.pipe(Stream.decodeText, Stream.mkString), probe.exitCode],
          { concurrency: 2 },
        );
        const state = output.trim();
        return (
          Number(exitCode) !== 0 ||
          state.length === 0 ||
          state.startsWith("Z") ||
          state.includes("E")
        );
      }),
    );
  });

const descendantSpec = (): NativeProcessSpec => {
  const descendantCode =
    "process.stdout.write(`READY ${process.ppid} ${process.pid}\\n`); setInterval(() => {}, 1000)";
  const workloadCode = [
    'import { spawn } from "node:child_process";',
    `spawn(${JSON.stringify(process.execPath)}, ["--input-type=module", "-e", ${JSON.stringify(descendantCode)}], { stdio: ["ignore", "inherit", "ignore"] });`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  return {
    executable: process.execPath,
    args: ["--input-type=module", "-e", workloadCode],
  };
};

describe("native process group cleanup", () => {
  it.live.skipIf(process.platform === "win32")(
    "kills the workload group when reporting its PID fails",
    () =>
      Effect.acquireUseRelease(
        // oxlint-disable effecttsgo/global-error-in-effect-catch,effecttsgo/global-error-in-effect-failure -- Preserve subprocess setup failures for the test assertion.
        Effect.tryPromise({
          // oxlint-disable-next-line effecttsgo/async-function -- This test coordinates Node subprocess events.
          try: async () => {
            const launcher = defaultNativeProcessLauncher();
            const workloadMarker = `fd5-workload-${process.pid}`;
            const child = spawnProcess(launcher.command, launcher.args, {
              detached: true,
              stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"],
            });
            const launcherPid = child.pid;
            const stdout = child.stdout;
            const stderr = child.stderr;
            const owner = child.stdio[3];
            const payload = child.stdio[4];
            const report = child.stdio.slice(5)[0];
            let workloadPid: number | undefined;
            let descendantPid: number | undefined;
            let observedWorkloadPid: number | undefined;
            const workloadGroupIds = new Set<number>();
            const scanWorkloadProcesses = () => {
              const output = execFileSync("ps", ["-axo", "pid=,pgid=,stat=,command="], {
                encoding: "utf8",
              });
              const rows = output.split(/\r?\n/).flatMap((line) => {
                const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
                if (
                  match === null ||
                  match[1] === undefined ||
                  match[2] === undefined ||
                  match[3] === undefined ||
                  match[4] === undefined
                )
                  return [];
                return [
                  {
                    pid: Number(match[1]),
                    groupId: Number(match[2]),
                    state: match[3],
                    command: match[4],
                  },
                ];
              });
              for (const row of rows) {
                if (row.command.includes(workloadMarker)) {
                  workloadGroupIds.add(row.groupId);
                  observedWorkloadPid = row.pid;
                }
              }
              return rows;
            };
            const killGroup = (pid: number | undefined) => {
              if (pid === undefined) return;
              try {
                process.kill(-pid, "SIGKILL");
              } catch (cause) {
                if (
                  typeof cause !== "object" ||
                  cause === null ||
                  !("code" in cause) ||
                  cause.code !== "ESRCH"
                )
                  throw cause;
              }
            };
            const killOwnedGroups = () => {
              owner?.destroy();
              try {
                scanWorkloadProcesses();
              } catch {
                // The READY PID remains an exact fallback if process inspection is unavailable.
              }
              for (const groupId of workloadGroupIds) killGroup(groupId);
              killGroup(workloadPid);
              killGroup(launcherPid);
            };
            if (
              stdout === null ||
              stderr === null ||
              owner == null ||
              payload == null ||
              !("end" in payload) ||
              report == null
            ) {
              killOwnedGroups();
              // oxlint-disable-next-line effecttsgo/global-error-in-effect-failure -- Missing OS pipes invalidate this subprocess test.
              throw new Error("Launcher test pipes were not created");
            }
            let output = "";
            try {
              stdout.setEncoding("utf8").on("data", (chunk: string) => {
                output += chunk;
                const match = /READY (\S+) (\d+) (\d+)/.exec(output);
                if (match !== null && match[1] === workloadMarker) {
                  workloadPid = Number(match[2]);
                  descendantPid = Number(match[3]);
                  workloadGroupIds.add(workloadPid);
                }
              });
              stderr.resume();
              const reportClosed = once(report, "close");
              report.destroy();
              await reportClosed;
              // oxlint-disable-next-line effecttsgo/new-promise -- Observe the child exit event as a typed tuple.
              const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
                child.once("exit", (code, signal) => resolve([code, signal]));
              });
              const stdoutClosed = once(stdout, "end");
              // oxlint-disable effecttsgo/prefer-schema-over-json -- The launcher protocol is JSON over fd4.
              payload.end(
                JSON.stringify({
                  executable: process.execPath,
                  args: [
                    "--input-type=module",
                    "-e",
                    [
                      "import { spawn } from 'node:child_process';",
                      "process.title = process.argv[1];",
                      "const descendant = spawn(process.execPath, ['-e', 'process.title = process.argv[1]; setInterval(() => {}, 1000)', process.argv[1]], { stdio: ['ignore', 'inherit', 'ignore'] });",
                      "process.stdout.write(`READY ${process.title} ${process.pid} ${descendant.pid}\\n`);",
                      "setInterval(() => {}, 1000);",
                    ].join("\n"),
                    workloadMarker,
                  ],
                }),
              );
              // oxlint-enable effecttsgo/prefer-schema-over-json
              let timer: NodeJS.Timeout | undefined;
              // oxlint-disable effecttsgo/new-promise -- Race process events against a timeout guard.
              const completion = new Promise<[[number | null, NodeJS.Signals | null], unknown[]]>(
                (resolve, reject) => {
                  // oxlint-disable-next-line effecttsgo/global-timers -- Bound a potentially leaked subprocess.
                  timer = setTimeout(() => {
                    // oxlint-disable-next-line effecttsgo/global-error-in-effect-failure -- Timeout reports a leaked process group.
                    reject(new Error("Launcher kept stdout open"));
                  }, 5_000);
                  Promise.all([exited, stdoutClosed]).then(resolve, reject);
                },
              );
              // oxlint-enable effecttsgo/new-promise
              let result: [[number | null, NodeJS.Signals | null], unknown[]];
              try {
                result = await completion;
              } finally {
                if (timer !== undefined) clearTimeout(timer);
              }
              const [exitResult] = result;
              const [code, signal] = exitResult;
              const hasLiveWorkloadProcesses = scanWorkloadProcesses().some(
                ({ groupId, state }) =>
                  workloadGroupIds.has(groupId) && !state.startsWith("Z") && !state.includes("E"),
              );
              return {
                code,
                signal,
                workloadPid,
                descendantPid,
                hasLiveWorkloadProcesses,
                cleanup: killOwnedGroups,
              };
            } catch (cause) {
              killOwnedGroups();
              const leakedWorkloadPid = workloadPid ?? observedWorkloadPid;
              if (cause instanceof Error && leakedWorkloadPid !== undefined)
                throw new Error(
                  `${cause.message}; ${workloadPid === undefined ? "workload marker" : "READY workload"} remained at PID ${leakedWorkloadPid}`,
                );
              throw cause;
            }
          },
          catch: (cause) => new Error(String(cause)),
        }),
        // oxlint-enable effecttsgo/global-error-in-effect-catch,effecttsgo/global-error-in-effect-failure
        ({ code, signal, workloadPid, descendantPid, hasLiveWorkloadProcesses }) =>
          Effect.gen(function* () {
            expect(code).toBe(127);
            expect(signal).toBeNull();
            if (workloadPid !== undefined) expect(yield* assertExited(workloadPid)).toBe(true);
            if (descendantPid !== undefined) expect(yield* assertExited(descendantPid)).toBe(true);
            expect(hasLiveWorkloadProcesses).toBe(false);
          }),
        ({ cleanup }) => Effect.sync(cleanup),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails startup when the launcher omits its workload process group", () =>
    Effect.scoped(
      spawnNativeProcess(spec, { command: "test-launcher", args: [] }).pipe(Effect.exit),
    ).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        makeSpawner({ groupIdOutput: "invalid\n" }),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
            expect(error).toMatchObject({
              message: "Native launcher did not report a valid workload process group",
            });
          }
        }),
      ),
    ),
  );

  it.live.skipIf(process.platform === "win32")(
    "reaps descendants after the workload exits and preserves its input and exit code",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const native = yield* spawnNativeProcess({
            executable: process.execPath,
            stdin: "pipe",
            args: [
              "--input-type=module",
              "-e",
              [
                "import { spawn } from 'node:child_process';",
                "const chunks = [];",
                "for await (const chunk of process.stdin) chunks.push(chunk);",
                "await new Promise((resolve) => process.stdout.write(Buffer.concat(chunks), resolve));",
                "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
                "process.exit(17);",
              ].join("\n"),
            ],
          });
          yield* Stream.run(Stream.succeed(new TextEncoder().encode("tool input")), native.stdin);
          const [output, exitCode] = yield* Effect.all(
            [native.stdout.pipe(Stream.decodeText, Stream.mkString), native.exitCode],
            { concurrency: 2 },
          ).pipe(Effect.timeout("5 seconds"));
          expect(output).toBe("tool input");
          expect(Number(exitCode)).toBe(17);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(process.platform === "win32")(
    "cleans the workload group after the launcher dies",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const native = yield* spawnNativeProcess({
            executable: process.execPath,
            args: [
              "--input-type=module",
              "-e",
              [
                "import { spawn } from 'node:child_process';",
                "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
                "process.stdout.write(`READY ${process.pid} ${descendant.pid}\\n`);",
                "setInterval(() => {}, 1000);",
              ].join("\n"),
            ],
          });
          const output = yield* Effect.acquireRelease(
            Effect.gen(function* () {
              const text = yield* Ref.make("");
              const ready = yield* Deferred.make<void>();
              const closed = yield* Deferred.make<void>();
              yield* native.stdout.pipe(
                Stream.decodeText,
                Stream.runForEach((chunk) =>
                  Effect.gen(function* () {
                    const value = yield* Ref.updateAndGet(text, (current) => current + chunk);
                    if (value.includes("READY ")) yield* Deferred.succeed(ready, undefined);
                  }),
                ),
                Effect.tap(() => Deferred.succeed(closed, undefined)),
                Effect.forkChild,
              );
              return { text, ready, closed };
            }),
            () => native.kill.pipe(Effect.ignore),
          );
          yield* Deferred.await(output.ready);
          process.kill(Number(native.pid), "SIGKILL");
          yield* native.kill;
          yield* Deferred.await(output.closed).pipe(Effect.timeout("5 seconds"));
          const match = /READY \d+ (\d+)/.exec(yield* Ref.get(output.text));
          expect(match).not.toBeNull();
          if (match === null) return;
          const [state, status] = yield* Effect.scoped(
            Effect.gen(function* () {
              const descendant = yield* ChildProcess.make(
                "/bin/ps",
                ["-p", match[1] ?? "", "-o", "stat="],
                { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
              );
              return yield* Effect.all(
                [descendant.stdout.pipe(Stream.decodeText, Stream.mkString), descendant.exitCode],
                { concurrency: 2 },
              );
            }),
          );
          expect(
            (Number(status) === 1 && state.trim() === "") ||
              (Number(status) === 0 && state.trim().startsWith("Z")),
          ).toBe(true);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(process.platform !== "darwin")(
    "accepts EPERM when a valid process-group listing contains only zombies",
    () =>
      Effect.gen(function* () {
        const { result } = yield* runKill({ groupOutput: `${targetPid} Z+\n` });
        expect(Exit.isSuccess(result)).toBe(true);
      }),
  );

  it.live.skipIf(process.platform !== "darwin")(
    "accepts EPERM when a valid process-group listing contains only exiting members",
    () =>
      Effect.gen(function* () {
        const { result } = yield* runKill({ groupOutput: `${targetPid} ?E\n` });
        expect(Exit.isSuccess(result)).toBe(true);
      }),
  );

  it.effect.skipIf(process.platform !== "darwin")(
    "preserves EPERM when process-group inspection stalls",
    () =>
      Effect.gen(function* () {
        const inspectionStarted = yield* Deferred.make<void>();
        const inspectionClosed = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          runKill({ groupStallReady: inspectionStarted, groupStallClosed: inspectionClosed }).pipe(
            Effect.timeout("3 seconds"),
          ),
        );
        yield* Deferred.await(inspectionStarted);
        yield* TestClock.adjust("3 seconds");
        const result = yield* Fiber.join(fiber).pipe(Effect.exit);
        expect(Exit.isSuccess(result)).toBe(true);
        if (Exit.isSuccess(result)) {
          expect(Exit.isFailure(result.value.result)).toBe(true);
          if (Exit.isFailure(result.value.result)) {
            const error = Option.getOrUndefined(Cause.findErrorOption(result.value.result.cause));
            expect(error).toMatchObject({ cause: { code: "EPERM" } });
          }
        }
        expect(yield* Deferred.isDone(inspectionClosed)).toBe(true);
      }),
  );

  it.live.skipIf(process.platform === "darwin" || process.platform === "win32")(
    "preserves EPERM outside Darwin",
    () =>
      Effect.gen(function* () {
        const { result } = yield* runKill({ groupOutput: `${targetPid} Z\n` });
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(error).toMatchObject({ cause: { code: "EPERM" } });
        }
      }),
  );

  it.live.skipIf(process.platform !== "darwin")(
    "accepts EPERM when a valid listing has no matching process group",
    () =>
      Effect.gen(function* () {
        const { result } = yield* runKill({ groupOutput: "1 S\n2 Z\n" });
        expect(Exit.isSuccess(result)).toBe(true);
      }),
  );

  it.live.skipIf(process.platform !== "darwin")(
    "preserves EPERM when the group still has a live member",
    () =>
      Effect.gen(function* () {
        const { result } = yield* runKill({ groupOutput: `${targetPid} Z\n${targetPid} S\n` });
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(error).toMatchObject({ cause: { code: "EPERM" } });
        }
      }),
  );

  it.live.skipIf(process.platform !== "darwin")(
    "preserves EPERM when an exiting group also has a live member",
    () =>
      Effect.gen(function* () {
        const { result } = yield* runKill({ groupOutput: `${targetPid} ?E\n${targetPid} S\n` });
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(error).toMatchObject({ cause: { code: "EPERM" } });
        }
      }),
  );

  it.live.skipIf(process.platform !== "darwin")(
    "preserves EPERM when process-group inspection is malformed or empty",
    () =>
      Effect.gen(function* () {
        const malformed = yield* runKill({ groupOutput: `${targetPid}\n` });
        const empty = yield* runKill({ groupOutput: "" });
        expect(Exit.isFailure(malformed.result)).toBe(true);
        expect(Exit.isFailure(empty.result)).toBe(true);
        if (Exit.isFailure(malformed.result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(malformed.result.cause));
          expect(error).toMatchObject({ cause: { code: "EPERM" } });
        }
        if (Exit.isFailure(empty.result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(empty.result.cause));
          expect(error).toMatchObject({ cause: { code: "EPERM" } });
        }
      }),
  );

  it.live.skipIf(process.platform !== "darwin")(
    "preserves EPERM when process-group inspection exits unsuccessfully",
    () =>
      Effect.gen(function* () {
        const { result } = yield* runKill({ groupOutput: `${targetPid} Z\n`, groupExitCode: 1 });
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(error).toMatchObject({ cause: { code: "EPERM" } });
        }
      }),
  );

  it.live.skipIf(process.platform !== "darwin")(
    "preserves EPERM when process-group inspection cannot spawn",
    () =>
      Effect.gen(function* () {
        const { result } = yield* runKill({ groupSpawnFailure: true });
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(error).toMatchObject({ cause: { code: "EPERM" } });
        }
      }),
  );

  it.live.skipIf(process.platform !== "darwin")(
    "preserves the original EPERM when process-group inspection defects",
    () =>
      Effect.gen(function* () {
        const { result } = yield* runKill({ groupForeignSpawnDefect: true });
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(error).toMatchObject({ cause: { code: "EPERM" } });
        }
      }),
  );

  it.live.skipIf(process.platform !== "darwin")(
    "checks real launcher and workload groups through the cleanup fallback",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const native = yield* spawnNativeProcess({
            executable: process.execPath,
            args: [
              "--input-type=module",
              "-e",
              "process.stdout.write(`READY ${process.pid}\\n`); setInterval(() => {}, 1_000)",
            ],
          });
          const ready = yield* native.stdout.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.runHead,
          );
          expect(Option.isSome(ready)).toBe(true);
          if (Option.isNone(ready)) return;
          const workloadPid = Number(ready.value.replace("READY ", ""));
          expect(Number.isSafeInteger(workloadPid)).toBe(true);
          expect(workloadPid).not.toBe(Number(native.pid));
          expect(yield* native.isRunning).toBe(true);

          const liveWorkloadGroup = yield* runKill({
            targetPid: workloadPid,
            delegatePsTo: realSpawner,
          });
          expect(Exit.isFailure(liveWorkloadGroup.result)).toBe(true);

          const liveLauncherGroup = yield* runKill({
            targetPid: Number(native.pid),
            delegatePsTo: realSpawner,
          });
          expect(Exit.isFailure(liveLauncherGroup.result)).toBe(true);
          if (Exit.isFailure(liveLauncherGroup.result)) {
            const error = Option.getOrUndefined(
              Cause.findErrorOption(liveLauncherGroup.result.cause),
            );
            expect(error).toMatchObject({ cause: { code: "EPERM" } });
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps ordinary ESRCH cleanup successful", () =>
    runKill({ killCode: "ESRCH" }).pipe(
      Effect.tap(({ result }) => Effect.sync(() => expect(Exit.isSuccess(result)).toBe(true))),
    ),
  );

  it.live.skipIf(process.platform === "win32")(
    "reports a scope finalizer failure while an owned process group remains live",
    () =>
      withMockedTargetKill(
        Effect.scoped(
          spawnNativeProcess(spec, { command: "test-launcher", args: [] }).pipe(Effect.asVoid),
        ).pipe(Effect.exit),
        targetPid,
        "EPERM",
        true,
      ).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(Exit.isFailure(result)).toBe(true);
            if (Exit.isFailure(result)) {
              const defect = Exit.findDefect(result);
              expect(defect._tag).toBe("Success");
              if (defect._tag === "Success")
                expect(defect.success).toMatchObject({ cause: { code: "EPERM" } });
            }
          }),
        ),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeSpawner({ groupOutput: `${targetPid} S\n` }),
        ),
      ),
  );

  it.live("reports a native launcher startup failure when workload spawn fails", () =>
    Effect.scoped(
      spawnNativeProcess({ executable: "/definitely/missing/native-workload" }).pipe(Effect.exit),
    ).pipe(
      Effect.provide(NodeServices.layer),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
            expect(error).toMatchObject({
              message: "Native launcher did not report a valid workload process group",
            });
          }
        }),
      ),
    ),
  );

  it.live.skipIf(process.platform === "win32")(
    "cleans the workload and its descendant when a native scope closes",
    () =>
      Effect.gen(function* () {
        const pids = yield* Effect.scoped(
          Effect.gen(function* () {
            const native = yield* spawnNativeProcess(descendantSpec());
            const ready = yield* native.stdout.pipe(
              Stream.decodeText,
              Stream.splitLines,
              Stream.runHead,
            );
            expect(Option.isSome(ready)).toBe(true);
            if (Option.isNone(ready))
              return yield* Effect.die("native process exited before readiness");
            const [, workloadPid, descendantPid] = ready.value.split(" ");
            expect(workloadPid).toBeDefined();
            expect(descendantPid).toBeDefined();
            return [Number(native.pid), Number(workloadPid), Number(descendantPid)] as const;
          }),
        );
        expect(pids).toHaveLength(3);
        for (const pid of pids) expect(yield* assertExited(pid), `pid ${pid}`).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(process.platform === "win32")(
    "cleans the workload and its descendant when the owning fiber is interrupted",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<readonly [number, number, number]>();
        const fiber = yield* Effect.forkChild(
          Effect.scoped(
            Effect.gen(function* () {
              const native = yield* spawnNativeProcess(descendantSpec());
              const ready = yield* native.stdout.pipe(
                Stream.decodeText,
                Stream.splitLines,
                Stream.runHead,
              );
              if (Option.isNone(ready))
                return yield* Effect.die("native process exited before readiness");
              const [, workloadPid, descendantPid] = ready.value.split(" ");
              yield* Deferred.succeed(started, [
                Number(native.pid),
                Number(workloadPid),
                Number(descendantPid),
              ]);
              return yield* Effect.never;
            }),
          ),
        );
        const pids = yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        yield* Fiber.await(fiber);
        for (const pid of pids) expect(yield* assertExited(pid), `pid ${pid}`).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(process.platform === "win32")(
    "does not lose a workload when launch is interrupted during the fd5 handshake",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
          const handshake = yield* Deferred.make<number>();
          const ready = yield* Deferred.make<void>();
          const releaseHandshake = yield* Deferred.make<void>();
          let ownedGroup: number | undefined;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (ownedGroup === undefined) return;
              try {
                process.kill(-ownedGroup, "SIGKILL");
              } catch {
                // The child scope may already have reaped this exact test group.
              }
            }),
          );
          const spawner = ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              const child = yield* delegate.spawn(command);
              if (
                !ChildProcess.isStandardCommand(command) ||
                !command.args.some((argument) => argument.includes("native-launcher"))
              )
                return child;
              yield* child.stdout.pipe(
                Stream.decodeText,
                Stream.splitLines,
                Stream.filter((line) => line === "native-workload-ready"),
                Stream.runHead,
                Effect.andThen(Deferred.succeed(ready, undefined)),
                Effect.forkScoped,
              );
              return ChildProcessSpawner.makeHandle({
                pid: child.pid,
                exitCode: child.exitCode,
                isRunning: child.isRunning,
                kill: child.kill,
                stdin: child.stdin,
                stdout: Stream.empty,
                stderr: child.stderr,
                all: child.all,
                getInputFd: child.getInputFd,
                getOutputFd: (fd) =>
                  fd === 5
                    ? child.getOutputFd(fd).pipe(
                        Stream.tap((bytes) =>
                          Effect.gen(function* () {
                            ownedGroup = Number(new TextDecoder().decode(bytes).trim());
                            yield* Deferred.succeed(handshake, ownedGroup);
                            yield* Deferred.await(releaseHandshake);
                          }),
                        ),
                      )
                    : child.getOutputFd(fd),
                unref: child.unref,
              });
            }),
          );
          const launch = yield* Effect.forkChild(
            Effect.scoped(
              spawnNativeProcess(
                {
                  executable: process.execPath,
                  args: [
                    "-e",
                    "process.on('SIGTERM', () => {}); process.stdout.write('native-workload-ready\\n'); setInterval(() => {}, 1000)",
                  ],
                  gracefulStopTimeout: "100 millis",
                },
                defaultNativeProcessLauncher(),
              ),
            ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          );
          const groupId = yield* Deferred.await(handshake);
          yield* Deferred.await(ready);
          yield* Effect.sync(() => launch.interruptUnsafe());
          yield* Deferred.succeed(releaseHandshake, undefined);
          yield* Fiber.await(launch);
          expect(yield* assertExited(groupId)).toBe(true);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );

  it.live("keeps the shared exit observation alive after a canceled waiter", () =>
    withMockedTargetKill(
      Effect.gen(function* () {
        const exitStarted = yield* Deferred.make<void>();
        const exitCode = yield* Deferred.make<ExitCode>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const native = yield* spawnNativeProcess(spec, {
              command: "test-launcher",
              args: [],
            });
            const first = yield* Effect.forkChild(native.exitCode);
            yield* Deferred.await(exitStarted);
            yield* Fiber.interrupt(first);
            yield* Deferred.succeed(exitCode, ChildProcessSpawner.ExitCode(17));
            expect(yield* native.exitCode).toBe(ChildProcessSpawner.ExitCode(17));
          }).pipe(
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              makeSpawner({ exitStarted, exitCode }),
            ),
          ),
        );
      }),
      targetPid,
      "ESRCH",
    ),
  );
});
