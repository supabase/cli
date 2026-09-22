import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Option, Sink, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { NodeServices } from "@effect/platform-node";
import { systemError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerType } from "effect/unstable/process/ChildProcessSpawner";
import type { ExitCode } from "effect/unstable/process/ChildProcessSpawner";
import { spawnNativeProcess, type NativeProcess, type NativeProcessSpec } from "./NativeProcess.ts";

const targetPid = 87_035;

interface FakeProcessOptions {
  readonly groupOutput?: string;
  readonly groupExitCode?: number;
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
        getOutputFd: () => Stream.empty,
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
    "checks a real process-group listing through the cleanup fallback",
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

          const absentGroup = yield* runKill({
            targetPid: workloadPid,
            delegatePsTo: realSpawner,
          });
          expect(Exit.isSuccess(absentGroup.result)).toBe(true);

          const liveGroup = yield* runKill({
            targetPid: Number(native.pid),
            delegatePsTo: realSpawner,
          });
          expect(Exit.isFailure(liveGroup.result)).toBe(true);
          if (Exit.isFailure(liveGroup.result)) {
            const error = Option.getOrUndefined(Cause.findErrorOption(liveGroup.result.cause));
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
          }),
        ),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeSpawner({ groupOutput: `${targetPid} S\n` }),
        ),
      ),
  );

  it.live("reports a native launcher startup failure through exitCode", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const native = yield* spawnNativeProcess({
          executable: "/definitely/missing/native-workload",
        });
        expect(Number(yield* native.exitCode)).toBe(127);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
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
