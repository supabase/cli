// oxlint-disable effecttsgo/prefer-schema-over-json -- raw child-process fixture payloads are protocol JSON, not product serialization.
import { NodeServices, NodeSocket } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Data, Deferred, Effect, Exit, Fiber, FileSystem, Path, Ref, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LogStoreError, makeLogStore, type LogStore } from "../supervisor/LogStore.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import { StackIdSchema } from "../public/StackId.ts";
import type { RuntimeWorkloadKey } from "./RuntimeDriver.ts";
import { RuntimeDriverError } from "./RuntimeDriver.ts";
import { makeNativeRuntime } from "./NativeRuntime.ts";
import {
  defaultNativeProcessLauncher,
  spawnNativeProcess,
  type NativeProcess,
} from "./NativeProcess.ts";

const stackId = StackIdSchema.make("d".repeat(64));

class ProcessTreeTestError extends Data.TaggedError("ProcessTreeTestError")<{
  readonly message: string;
}> {}

const workload = (id: string, bootstrap?: "database"): PlannedWorkload => ({
  id,
  capability: "database",
  ...(bootstrap === undefined ? {} : { bootstrap }),
  dependencies: [],
  readiness: { mode: "tcp" },
  artifacts: {
    native: { kind: "native", release: "test" },
    container: { kind: "container", image: `test/${id}` },
  },
  selected: { kind: "native", release: "test" },
});

const keyFor = (id: string): RuntimeWorkloadKey => ({
  stackId,
  workloadId: `database:${id}`,
});

const fixtureProcess = (message: string) => ({
  executable: process.execPath,
  args: [
    "-e",
    `process.stdout.write(${JSON.stringify(`${message}\n`)}); process.stderr.write(${JSON.stringify("stderr\n")}); setInterval(() => {}, 1000)`,
  ],
});

const oneShotProcess = (stdout: string, exitCode = 0) => ({
  executable: process.execPath,
  args: [
    "-e",
    `process.stdout.write(${JSON.stringify(`${stdout}\n`)}); process.stderr.write(${JSON.stringify("startup-stderr\n")}); process.exit(${exitCode})`,
  ],
});

const processPlan = <A>(main: A) => ({ startup: [], main });

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const signalOnLog = (
  base: LogStore,
  message: string,
  signal: Deferred.Deferred<void, never>,
): LogStore => ({
  ...base,
  append: (record) =>
    base
      .append(record)
      .pipe(
        Effect.tap((entry) =>
          entry.message === message ? Deferred.succeed(signal, undefined) : Effect.void,
        ),
      ),
});

// Native launcher tests create real process trees. Keep their timeout local to
// this suite so file-level parallelism does not turn the default 5s guard into
// a false failure while leaving the rest of the integration suite unchanged.
describe("native runtime", { timeout: 15_000 }, () => {
  it.live("rejects container artifacts before invoking native process resolution", () =>
    withPlatform(
      Effect.gen(function* () {
        let resolved = false;
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.sync(() => {
              resolved = true;
              return processPlan(fixtureProcess("unexpected"));
            }),
          waitForReadiness: () => Effect.void,
        });
        const containerSelected = workload("container");
        const result = yield* runtime
          .start(keyFor("container"), {
            ...containerSelected,
            selected: containerSelected.artifacts.container,
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(resolved).toBe(false);
      }),
    ),
  );

  it.live("starts, captures redacted output, and terminates exact workloads", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-runtime-" });
        const logStore = yield* makeLogStore({
          path: path.join(root, "logs.json"),
          knownSecrets: ["secret-value"],
        });
        const outputLogged = yield* Deferred.make<void>();
        const signaledLogStore = signalOnLog(logStore, "[REDACTED]", outputLogged);
        let startedProcess: NativeProcess | undefined;
        const runtime = yield* makeNativeRuntime({
          resolveProcess: (_key, _entry) =>
            Effect.succeed(processPlan(fixtureProcess("secret-value"))),
          logStore: signaledLogStore,
          waitForReadiness: (_key, _workload, process) =>
            Effect.sync(() => {
              startedProcess = process;
            }),
        });
        const key = keyFor("one");
        const ready = yield* runtime.start(key, workload("one"));
        expect(ready.state).toBe("ready");
        yield* Deferred.await(outputLogged);
        const values = yield* runtime.observe(stackId);
        expect(values).toHaveLength(1);
        yield* runtime.stop(key);
        expect((yield* runtime.observe(stackId))[0]?.state).toBe("stopped");
        expect(startedProcess).toBeDefined();
        if (startedProcess !== undefined) expect(yield* startedProcess.isRunning).toBe(false);
        expect((yield* logStore.read()).map((entry) => entry.message)).toContain("[REDACTED]");
        yield* runtime.remove(key);
        expect(yield* runtime.observe(stackId)).toEqual([]);
      }),
    ),
  );

  it.live("publishes an unexpected native workload exit after readiness", () =>
    withPlatform(
      Effect.gen(function* () {
        let startedProcess: NativeProcess | undefined;
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () => Effect.succeed(processPlan(fixtureProcess("native-watch"))),
          waitForReadiness: (_key, _workload, process) =>
            Effect.sync(() => {
              startedProcess = process;
            }),
        });
        const ready = yield* runtime.start(keyFor("watch"), workload("watch"));
        expect(ready.state).toBe("ready");
        expect(startedProcess).toBeDefined();
        if (startedProcess !== undefined) {
          yield* startedProcess.kill;
          yield* startedProcess.exitCode.pipe(Effect.exit);
          yield* Effect.yieldNow;
        }
        const observed = yield* runtime.observe(stackId);
        expect(observed).toEqual([
          expect.objectContaining({ workloadId: keyFor("watch").workloadId, state: "failed" }),
        ]);
        yield* runtime.remove(keyFor("watch"));
      }),
    ),
  );

  it.live("keeps a ready workload after the losing exit observer is interrupted", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-native-exit-observer-",
        });
        const logStore = yield* makeLogStore({ path: path.join(root, "logs.json") });
        const readinessEntered = yield* Deferred.make<void>();
        const readinessRelease = yield* Deferred.make<void>();
        let startedProcess: NativeProcess | undefined;
        const outputReady = yield* Deferred.make<void>();
        const signaledLogStore = signalOnLog(logStore, "main-started", outputReady);
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () => Effect.succeed(processPlan(fixtureProcess("main-started"))),
          logStore: signaledLogStore,
          waitForReadiness: (_key, _workload, process) =>
            Effect.sync(() => {
              startedProcess = process;
            }).pipe(
              Effect.andThen(Deferred.succeed(readinessEntered, undefined)),
              Effect.andThen(Deferred.await(readinessRelease)),
            ),
        });
        const key = keyFor("exit-observer");
        const caller = yield* runtime
          .start(key, workload("exit-observer"))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(readinessEntered);
        yield* Deferred.await(outputReady);
        yield* Deferred.succeed(readinessRelease, undefined);
        const ready = yield* Fiber.join(caller);
        expect(ready.state).toBe("ready");
        expect(startedProcess).toBeDefined();
        if (startedProcess !== undefined) expect(yield* startedProcess.isRunning).toBe(true);
        expect((yield* runtime.observe(stackId))[0]?.state).toBe("ready");
        yield* runtime.stop(key);
      }),
    ),
  );

  it.live("cleans up when readiness fails", () =>
    withPlatform(
      Effect.gen(function* () {
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () => Effect.succeed(processPlan(fixtureProcess("fails"))),
          waitForReadiness: (key) =>
            Effect.fail(
              new RuntimeDriverError({
                message: "fixture readiness failed",
                stackId: key.stackId,
                workloadId: key.workloadId,
              }),
            ),
        });
        const result = yield* runtime.start(keyFor("fails"), workload("fails")).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* runtime.observe(stackId)).toEqual([]);
      }),
    ),
  );

  it.live("fails readiness when a native process exits nonzero", () =>
    withPlatform(
      Effect.gen(function* () {
        const readiness = yield* Deferred.make<void>();
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.succeed(
              processPlan({
                executable: process.execPath,
                args: ["-e", "process.stderr.write('native failed\\n'); process.exit(3)"],
              }),
            ),
          waitForReadiness: () => Deferred.await(readiness),
        });
        const result = yield* runtime
          .start(keyFor("nonzero"), workload("nonzero"))
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* runtime.observe(stackId)).toEqual([]);
      }),
    ),
  );

  it.live("restarts a stopped exact key with a fresh process", () =>
    withPlatform(
      Effect.gen(function* () {
        let launches = 0;
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.sync(() => {
              launches += 1;
              return processPlan(fixtureProcess(`restart-${launches}`));
            }),
          waitForReadiness: () => Effect.void,
        });
        const key = keyFor("restart");
        yield* runtime.start(key, workload("restart"));
        yield* runtime.stop(key);
        const restarted = yield* runtime.start(key, workload("restart"));
        expect(restarted.state).toBe("ready");
        expect(launches).toBe(2);
        yield* runtime.remove(key);
      }),
    ),
  );

  it.live("keeps a shared start alive when one caller is interrupted", () =>
    withPlatform(
      Effect.gen(function* () {
        const spawned = yield* Deferred.make<void>();
        const readiness = yield* Deferred.make<void>();
        let launches = 0;
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.sync(() => {
              launches += 1;
              return processPlan(fixtureProcess("shared-start"));
            }).pipe(Effect.tap(() => Deferred.succeed(spawned, undefined))),
          waitForReadiness: () => Deferred.await(readiness),
        });
        const key = keyFor("shared-start");
        const firstCaller = yield* runtime
          .start(key, workload("shared-start"))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(spawned);
        yield* Fiber.interrupt(firstCaller);
        yield* Deferred.succeed(readiness, undefined);
        const ready = yield* runtime.start(key, workload("shared-start"));
        expect(ready.state).toBe("ready");
        expect(launches).toBe(1);
        yield* runtime.remove(key);
      }),
    ),
  );

  it.live("fails startup when log persistence fails before readiness", () =>
    withPlatform(
      Effect.gen(function* () {
        const readiness = yield* Deferred.make<void>();
        const logStore: LogStore = {
          path: "memory://failing-log-store",
          append: () =>
            Effect.fail(
              new LogStoreError({ path: "memory://failing-log-store", message: "disk full" }),
            ),
          read: () => Effect.succeed([]),
        };
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () => Effect.succeed(processPlan(fixtureProcess("log-failure"))),
          waitForReadiness: () => Deferred.await(readiness),
          logStore,
        });
        const result = yield* runtime
          .start(keyFor("log-failure"), workload("log-failure"))
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* runtime.observe(stackId)).toEqual([]);
      }),
    ),
  );

  it.live("runs native startup processes before main readiness and captures their logs", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-startup-" });
        const logStore = yield* makeLogStore({ path: path.join(root, "logs.json") });
        const mainLogged = yield* Deferred.make<void>();
        const signaledLogStore = signalOnLog(logStore, "main", mainLogged);
        let observedReady = false;
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.succeed({
              startup: [oneShotProcess("startup")],
              main: fixtureProcess("main"),
            }),
          logStore: signaledLogStore,
          waitForReadiness: () =>
            Effect.sync(() => {
              observedReady = true;
            }),
        });
        const key = keyFor("startup-order");
        const ready = yield* runtime.start(key, workload("startup-order"));
        expect(ready.state).toBe("ready");
        expect(observedReady).toBe(true);
        yield* Deferred.await(mainLogged);
        const messages = (yield* logStore.read()).map((entry) => entry.message);
        expect(messages.indexOf("startup")).toBeGreaterThanOrEqual(0);
        expect(messages).toContain("startup-stderr");
        expect(messages.indexOf("main")).toBeGreaterThan(messages.indexOf("startup"));
        yield* runtime.remove(key);
      }),
    ),
  );

  it.live("runs post-readiness startup processes before reporting ready", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-post-ready-" });
        const logStore = yield* makeLogStore({ path: path.join(root, "logs.json") });
        const postReadiness = {
          executable: process.execPath,
          args: [
            "-e",
            'process.stdout.write("post-ready\\n"); process.stderr.write("post-ready-stderr\\n")',
          ],
        };
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.succeed({
              startup: [],
              postReadiness: [postReadiness],
              main: fixtureProcess("main"),
            }),
          logStore,
          waitForReadiness: () => Effect.void,
        });
        const key = keyFor("post-readiness");
        const ready = yield* runtime.start(key, workload("post-readiness"));
        expect(ready.state).toBe("ready");
        const messages = (yield* logStore.read()).map((entry) => entry.message);
        expect(messages).toContain("post-ready");
        expect(messages).toContain("post-ready-stderr");
        yield* runtime.remove(key);
      }),
    ),
  );

  it.live("writes a completion witness only after a successful post-readiness process", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-marker-" });
        const marker = path.join(root, "data", "migration-complete");
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.succeed({
              startup: [],
              postReadiness: [{ ...oneShotProcess("migrated"), successMarker: marker }],
              main: fixtureProcess("main"),
            }),
          waitForReadiness: () => Effect.void,
        });
        const key = keyFor("marker");
        const ready = yield* runtime.start(key, workload("marker"));
        expect(ready.state).toBe("ready");
        expect(yield* fs.readFileString(marker)).toBe("completed\n");
        yield* runtime.stop(key);
      }),
    ),
  );

  it.live("bounds a native one-shot before it can report readiness", () =>
    withPlatform(
      Effect.gen(function* () {
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.succeed({
              startup: [
                {
                  executable: process.execPath,
                  args: ["-e", "setInterval(() => {}, 1000)"],
                  timeout: "20 millis",
                },
              ],
              main: fixtureProcess("never-main"),
            }),
          waitForReadiness: () => Effect.void,
        });
        const result = yield* runtime
          .start(keyFor("startup-timeout"), workload("startup-timeout"))
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.pretty(result.cause)).toContain("Native startup process timed out");
        expect(yield* runtime.observe(stackId)).toEqual([]);
      }),
    ),
  );

  it.live("does not leak host credentials into native workload children", () =>
    withPlatform(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "supabase-native-env-",
        });
        const logStore = yield* makeLogStore({ path: path.join(root, "logs.json") });
        const launcherPath = fileURLToPath(new URL("./native-launcher.ts", import.meta.url));
        const launcher = {
          command: process.execPath,
          args: [
            "-e",
            `process.env.PGPASSWORD="host-secret"; await import(${JSON.stringify(launcherPath)})`,
          ],
        };
        const runtime = yield* makeNativeRuntime({
          resolveLauncher: () => Effect.succeed(launcher),
          resolveProcess: () =>
            Effect.succeed({
              startup: [
                {
                  executable: process.execPath,
                  args: [
                    "-e",
                    'process.stdout.write(`${JSON.stringify({ password: process.env.PGPASSWORD ?? "missing", path: (process.env.PATH ?? "").length > 0 })}\\n`)',
                  ],
                },
              ],
              main: fixtureProcess("env-main"),
            }),
          waitForReadiness: () => Effect.void,
          logStore,
        });
        const key = keyFor("env-allowlist");
        yield* runtime.start(key, workload("env-allowlist"));
        const messages = (yield* logStore.read()).map((entry) => entry.message);
        expect(messages).toContain('{"password":"missing","path":true}');
        yield* runtime.stop(key);
      }),
    ),
  );

  it.live("does not report ready when post-readiness startup fails", () =>
    withPlatform(
      Effect.gen(function* () {
        let readinessCalled = false;
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.succeed({
              startup: [],
              postReadiness: [oneShotProcess("post-ready-failed", 7)],
              main: fixtureProcess("main"),
            }),
          waitForReadiness: () =>
            Effect.sync(() => {
              readinessCalled = true;
            }),
        });
        const result = yield* runtime
          .start(keyFor("post-readiness-failed"), workload("post-readiness-failed"))
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.pretty(result.cause)).toContain(
            "Native post-readiness process exited with code 7",
          );
        expect(readinessCalled).toBe(true);
        expect(yield* runtime.observe(stackId)).toEqual([]);
      }),
    ),
  );

  it.live("fails when the main workload exits while post-readiness is blocked", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-native-post-ready-main-exit-",
        });
        const readyPath = path.join(root, "main-ready");
        const releasePath = path.join(root, "post-release");
        expect(spawnSync("mkfifo", [readyPath]).status).toBe(0);
        expect(spawnSync("mkfifo", [releasePath]).status).toBe(0);
        const logStore = yield* makeLogStore({ path: path.join(root, "logs.json") });
        const postStartedSignal = yield* Deferred.make<void>();
        const signaledLogStore = signalOnLog(logStore, "post-blocked", postStartedSignal);
        const postReadiness = {
          executable: process.execPath,
          args: [
            "-e",
            `const fs = require("node:fs"); process.stdout.write("post-blocked\\n"); const fd = fs.openSync(${JSON.stringify(releasePath)}, "r"); fs.readSync(fd, Buffer.alloc(1), 0, 1, null); fs.closeSync(fd); process.stdout.write("post-complete\\n")`,
          ],
        };
        const main = {
          executable: process.execPath,
          args: [
            "-e",
            `const fs = require("node:fs"); const fd = fs.openSync(${JSON.stringify(readyPath)}, "r"); fs.readSync(fd, Buffer.alloc(1), 0, 1, null); fs.closeSync(fd); process.stdout.write("main-exited\\n"); process.exit(0)`,
          ],
        };
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.succeed({ startup: [], postReadiness: [postReadiness], main }),
          logStore: signaledLogStore,
          waitForReadiness: () => Effect.void,
        });
        const key = keyFor("post-readiness-main-exit");
        const caller = yield* runtime
          .start(key, workload("post-readiness-main-exit"))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(postStartedSignal);
        const releaseMain = spawnSync(
          process.execPath,
          ["-e", `require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, "x")`],
          { encoding: "utf8", timeout: 5_000 },
        );
        expect(releaseMain.error).toBeUndefined();
        expect(releaseMain.status).toBe(0);
        const result = yield* Fiber.join(caller).pipe(
          Effect.exit,
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () =>
              Effect.fail(
                new ProcessTreeTestError({
                  message: "Native caller lifecycle result timed out",
                }),
              ),
          }),
        );
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.pretty(result.cause)).toContain("exited before readiness");
        expect(yield* runtime.observe(stackId)).toEqual([]);
      }),
    ),
  );

  it.live("interrupts a post-readiness startup process through its exact child scope", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-native-post-interrupt-",
        });
        const pidPath = path.join(root, "pid");
        const logStore = yield* makeLogStore({ path: path.join(root, "logs.json") });
        const startedSignal = yield* Deferred.make<void>();
        const signaledLogStore = signalOnLog(logStore, "post-started", startedSignal);
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.succeed({
              startup: [],
              postReadiness: [
                {
                  executable: process.execPath,
                  args: [
                    "-e",
                    `require("node:fs").writeFileSync(${JSON.stringify(pidPath)},String(process.pid)); process.stdout.write("post-started\\n"); setInterval(()=>{},1000)`,
                  ],
                },
              ],
              main: fixtureProcess("never-main"),
            }),
          logStore: signaledLogStore,
          waitForReadiness: () => Effect.void,
        });
        const key = keyFor("post-readiness-interrupted");
        const caller = yield* runtime
          .start(key, workload("post-readiness-interrupted"))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(startedSignal);
        yield* runtime.stop(key);
        const result = yield* Fiber.join(caller).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        const pid = Number.parseInt(yield* fs.readFileString(pidPath), 10);
        expect(Number.isSafeInteger(pid)).toBe(true);
        const processState = yield* Effect.sync(() => {
          const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
            encoding: "utf8",
          });
          return result.stdout.trim();
        });
        expect(processState === "" || processState.startsWith("Z")).toBe(true);
      }),
    ),
  );

  it.live("interrupts a blocked post-readiness child when log persistence fails", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-native-post-log-failure-",
        });
        const pidPath = path.join(root, "pid");
        const stoppedPath = path.join(root, "stopped");
        const logStore: LogStore = {
          path: "memory://native-post-log-failure",
          append: () =>
            Effect.fail(
              new LogStoreError({
                path: "memory://native-post-log-failure",
                message: "disk full",
              }),
            ),
          read: () => Effect.succeed([]),
        };
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.succeed({
              startup: [],
              postReadiness: [
                {
                  executable: process.execPath,
                  args: [
                    "-e",
                    `const fs=require("node:fs"); fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid)); const stop=()=>{fs.writeFileSync(${JSON.stringify(stoppedPath)},"stopped"); process.exit(0)}; process.on("SIGTERM",stop); process.on("SIGINT",stop); process.stdout.write("post-log-failure\\n"); setInterval(()=>{},1000);`,
                  ],
                },
              ],
              main: {
                executable: process.execPath,
                args: ["-e", "setInterval(() => {}, 1000)"],
              },
            }),
          logStore,
          waitForReadiness: () => Effect.void,
        });
        const result = yield* runtime
          .start(keyFor("post-log-failure"), workload("post-log-failure"))
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        const pid = Number.parseInt(yield* fs.readFileString(pidPath), 10);
        expect(Number.isSafeInteger(pid)).toBe(true);
        expect(yield* fs.readFileString(stoppedPath)).toBe("stopped");
        expect(yield* runtime.observe(stackId)).toEqual([]);
      }),
    ),
  );

  it.live("does not spawn the native main process when startup exits nonzero", () =>
    withPlatform(
      Effect.gen(function* () {
        let readinessCalled = false;
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.succeed({
              startup: [oneShotProcess("startup-failed", 7)],
              // This path is intentionally invalid: a correct runtime must
              // fail on the startup process before attempting to spawn it.
              main: { executable: "/missing/native-main" },
            }),
          waitForReadiness: () =>
            Effect.sync(() => {
              readinessCalled = true;
            }),
        });
        const result = yield* runtime
          .start(keyFor("startup-failed"), workload("startup-failed"))
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(readinessCalled).toBe(false);
        expect(yield* runtime.observe(stackId)).toEqual([]);
      }),
    ),
  );

  it.live("drains startup output after the child exits", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-drain-" });
        const logStore = yield* makeLogStore({ path: path.join(root, "logs.json") });
        const startupOutputSignal = yield* Deferred.make<void>();
        const signaledLogStore = signalOnLog(logStore, "startup-late", startupOutputSignal);
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.succeed({
              startup: [
                {
                  executable: process.execPath,
                  args: ["-e", 'process.stdout.write("startup-late\\n"); process.exit(0)'],
                },
              ],
              main: fixtureProcess("drained-main"),
            }),
          logStore: signaledLogStore,
          waitForReadiness: () => Effect.void,
        });
        const caller = yield* runtime
          .start(keyFor("startup-drain"), workload("startup-drain"))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(startupOutputSignal);
        const ready = yield* Fiber.join(caller);
        expect(ready.state).toBe("ready");
        yield* runtime.remove(keyFor("startup-drain"));
      }),
    ),
  );
  it.live("interrupts a startup process through its exact child scope", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-native-interrupt-" });
        const pidPath = path.join(root, "pid");
        const stoppedPath = path.join(root, "stopped");
        const logStore = yield* makeLogStore({ path: path.join(root, "logs.json") });
        const startedSignal = yield* Deferred.make<void>();
        const signaledLogStore = signalOnLog(logStore, "started", startedSignal);
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.succeed({
              startup: [
                {
                  executable: process.execPath,
                  args: [
                    "-e",
                    `const fs=require("node:fs"); fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid)); const stop=()=>{fs.writeFileSync(${JSON.stringify(stoppedPath)},"stopped"); process.exit(0)}; process.on("SIGTERM",stop); process.on("SIGINT",stop); process.stdout.write("started\\n"); setInterval(()=>{},1000)`,
                  ],
                },
              ],
              main: fixtureProcess("never-main"),
            }),
          logStore: signaledLogStore,
          waitForReadiness: () => Effect.void,
        });
        const key = keyFor("startup-interrupted");
        const caller = yield* runtime
          .start(key, workload("startup-interrupted"))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(startedSignal);
        yield* runtime.stop(key);
        yield* Fiber.interrupt(caller);
        expect(Number.isSafeInteger(Number.parseInt(yield* fs.readFileString(pidPath), 10))).toBe(
          true,
        );
        expect(yield* fs.readFileString(stoppedPath)).toBe("stopped");
      }),
    ),
  );

  it.live("marks a ready workload failed when log persistence fails afterward", () =>
    withPlatform(
      Effect.gen(function* () {
        const appendStarted = yield* Deferred.make<void>();
        const appendFailure = yield* Deferred.make<never, LogStoreError>();
        const logStore: LogStore = {
          path: "memory://failing-log-store-after-ready",
          append: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(appendStarted, undefined);
              return yield* Deferred.await(appendFailure);
            }),
          read: () => Effect.succeed([]),
        };
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.succeed(processPlan(fixtureProcess("log-failure-after-ready"))),
          waitForReadiness: () => Effect.void,
          logStore,
        });
        const key = keyFor("log-failure-after-ready");
        const ready = yield* runtime.start(key, workload("log-failure-after-ready"));
        expect(ready.state).toBe("ready");
        yield* Deferred.await(appendStarted);
        yield* Deferred.fail(
          appendFailure,
          new LogStoreError({
            path: logStore.path,
            message: "disk full",
          }),
        );
        yield* Effect.yieldNow;
        const observed = yield* runtime.observe(stackId);
        expect(observed[0]?.state).toBe("failed");
        yield* runtime.remove(key);
      }),
    ),
  );

  it.live("runs database bootstrap before reporting readiness", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-native-post-ready-bootstrap-",
        });
        const postCompletePath = path.join(root, "post-complete");
        let applied = false;
        let postCompletedBeforeBootstrap = false;
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () =>
            Effect.succeed({
              startup: [],
              postReadiness: [
                {
                  executable: process.execPath,
                  args: [
                    "-e",
                    `require("node:fs").writeFileSync(${JSON.stringify(postCompletePath)}, "done"); process.stdout.write("post-complete\\n")`,
                  ],
                },
              ],
              main: fixtureProcess("database"),
            }),
          waitForReadiness: () => Effect.void,
          bootstrapDatabase: () =>
            fs.exists(postCompletePath).pipe(
              Effect.mapError(
                (error) =>
                  new RuntimeDriverError({
                    message: "Unable to inspect post-readiness marker",
                    stackId,
                    workloadId: "database:bootstrap",
                    cause: error,
                  }),
              ),
              Effect.tap((completed) =>
                Effect.sync(() => {
                  postCompletedBeforeBootstrap = completed;
                  applied = true;
                }),
              ),
              Effect.asVoid,
            ),
        });
        const key = keyFor("bootstrap");
        const ready = yield* runtime.start(key, workload("bootstrap", "database"));
        expect(applied).toBe(true);
        expect(postCompletedBeforeBootstrap).toBe(true);
        expect(ready.state).toBe("ready");
        yield* runtime.stop(key);
        yield* runtime.remove(key);
      }),
    ),
  );

  it.live("requires a database session and plan for marked workloads", () =>
    withPlatform(
      Effect.gen(function* () {
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () => Effect.succeed(processPlan(fixtureProcess("database"))),
          waitForReadiness: () => Effect.void,
        });
        const result = yield* runtime
          .start(keyFor("missing-bootstrap"), workload("missing-bootstrap", "database"))
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* runtime.observe(stackId)).toEqual([]);
      }),
    ),
  );

  it.live("cleans up the native process when database bootstrap fails", () =>
    withPlatform(
      Effect.gen(function* () {
        const bootstrapError = new RuntimeDriverError({
          message: "database bootstrap failed",
          stackId,
          workloadId: "database:failed-bootstrap",
        });
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () => Effect.succeed(processPlan(fixtureProcess("database"))),
          waitForReadiness: () => Effect.void,
          bootstrapDatabase: () => Effect.fail(bootstrapError),
        });
        const result = yield* runtime
          .start(keyFor("failed-bootstrap"), workload("failed-bootstrap", "database"))
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* runtime.observe(stackId)).toEqual([]);
      }),
    ),
  );

  it.live("isolates exact workload identities while stopping one", () =>
    withPlatform(
      Effect.gen(function* () {
        const runtime = yield* makeNativeRuntime({
          resolveProcess: (_key, entry) => Effect.succeed(processPlan(fixtureProcess(entry.id))),
          waitForReadiness: () => Effect.void,
        });
        const first = keyFor("isolated-one");
        const second = keyFor("isolated-two");
        yield* Effect.all(
          [
            runtime.start(first, workload("isolated-one")),
            runtime.start(second, workload("isolated-two")),
          ],
          { concurrency: "unbounded" },
        );
        yield* runtime.stop(first);
        expect(
          (yield* runtime.observe(stackId)).map((entry) => [entry.workloadId, entry.state]),
        ).toEqual([
          ["database:isolated-one", "stopped"],
          ["database:isolated-two", "ready"],
        ]);
        yield* runtime.remove(first);
        yield* runtime.remove(second);
      }),
    ),
  );

  // The helper below is a raw Node launcher fixture; its JSON is the same fd4
  // payload covered by NativeProcess integration, not product serialization.
  it.live("kills the native process tree when its owner pipe closes under Bun and Node", () =>
    withPlatform(
      Effect.gen(function* () {
        const launcherArgs = defaultNativeProcessLauncher().args;
        const runtimes = [{ command: process.execPath }, { command: "node" }] as const;
        for (const runtime of runtimes) {
          yield* Effect.gen(function* () {
            const targetLauncher = { command: runtime.command, args: launcherArgs };
            const descendantCode = `
          const net = require("node:net");
          const server = net.createServer();
          server.listen({ host: "127.0.0.1", port: 0 }, () => {
            const address = server.address();
            if (typeof address === "object" && address !== null) {
              process.stdout.write(\`DESC_READY \${address.port}\\n\`);
            }
          });
        `;
            const targetCode = `
          const net = require("node:net");
          const { spawn } = require("node:child_process");
          process.stdout.on("error", () => {});
          process.on("SIGTERM", () => process.stdout.write("TARGET_SIGTERM\\n"));
          const server = net.createServer();
          server.listen({ host: "127.0.0.1", port: 0 }, () => {
            const address = server.address();
            if (typeof address === "object" && address !== null) {
              process.stdout.write(\`TARGET_READY \${address.port}\\n\`);
            }
            const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], {
              stdio: ["ignore", "pipe", "inherit"]
            });
            child.stdout.on("data", (chunk) => {
              if (!process.stdout.destroyed) process.stdout.write(chunk);
            });
          });
        `;
            const ownerCode = `
          const { spawn } = require("node:child_process");
          const launcherProcess = spawn(${JSON.stringify(targetLauncher.command)}, ${JSON.stringify(targetLauncher.args)}, {
            detached: true,
            stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"]
          });
          launcherProcess.stdio[4].end(JSON.stringify({
            executable: ${JSON.stringify(runtime.command)},
            args: ["-e", ${JSON.stringify(targetCode)}]
          }));
          process.stdout.write("LAUNCHER_READY " + launcherProcess.pid + "\\n");
          setInterval(() => {}, 1000);
        `;
            const owner = yield* ChildProcess.make(process.execPath, ["-e", ownerCode], {
              stdout: "pipe",
              stderr: "pipe",
              detached: true,
            });
            const stderr = yield* Ref.make("");
            yield* owner.stderr.pipe(
              Stream.decodeText,
              Stream.runForEach((chunk) => Ref.update(stderr, (current) => current + chunk)),
              Effect.forkChild({ startImmediately: true }),
            );
            const launcherReady = yield* Deferred.make<string>();
            const targetReady = yield* Deferred.make<string>();
            const descendantReady = yield* Deferred.make<string>();
            const targetSignal = yield* Deferred.make<void>();
            const outputFiber = yield* owner.stdout.pipe(
              Stream.decodeText,
              Stream.splitLines,
              Stream.runForEach((line) =>
                Effect.gen(function* () {
                  if (line.startsWith("LAUNCHER_READY "))
                    yield* Deferred.succeed(launcherReady, line);
                  else if (line.startsWith("TARGET_READY "))
                    yield* Deferred.succeed(targetReady, line);
                  else if (line.startsWith("DESC_READY "))
                    yield* Deferred.succeed(descendantReady, line);
                  else if (line === "TARGET_SIGTERM")
                    yield* Deferred.succeed(targetSignal, undefined);
                }),
              ),
              Effect.forkChild({ startImmediately: true }),
            );
            const output = yield* Deferred.await(descendantReady).pipe(
              Effect.timeoutOrElse({
                duration: "3 seconds",
                orElse: () =>
                  Effect.gen(function* () {
                    const diagnostics = yield* Ref.get(stderr);
                    return yield* new ProcessTreeTestError({
                      message: `native launcher readiness timed out: ${diagnostics}`,
                    });
                  }),
              }),
            );
            const launcherLine = yield* Deferred.await(launcherReady);
            const targetLine = yield* Deferred.await(targetReady);
            const targetPort = Number.parseInt(targetLine.slice("TARGET_READY ".length), 10);
            const descendantPort = Number.parseInt(output.slice("DESC_READY ".length), 10);
            expect(Number.isSafeInteger(targetPort)).toBe(true);
            expect(Number.isSafeInteger(descendantPort)).toBe(true);
            const launcherPid = Number.parseInt(launcherLine.slice("LAUNCHER_READY ".length), 10);
            expect(Number.isSafeInteger(launcherPid)).toBe(true);
            const targetSocket = yield* NodeSocket.makeNet({ host: "127.0.0.1", port: targetPort });
            const descendantSocket = yield* NodeSocket.makeNet({
              host: "127.0.0.1",
              port: descendantPort,
            });
            const targetClosedSignal = yield* Deferred.make<void>();
            const targetClosed = yield* targetSocket
              .runRaw(() => Effect.void, {
                onOpen: Deferred.succeed(targetClosedSignal, undefined),
              })
              .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(targetClosedSignal);
            const descendantClosedSignal = yield* Deferred.make<void>();
            const descendantClosed = yield* descendantSocket
              .runRaw(() => Effect.void, {
                onOpen: Deferred.succeed(descendantClosedSignal, undefined),
              })
              .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(descendantClosedSignal);
            expect(
              spawnSync("kill", ["-TERM", `-${launcherPid}`], { encoding: "utf8" }).status,
            ).toBe(0);
            yield* Deferred.await(targetSignal).pipe(
              Effect.timeoutOrElse({
                duration: "3 seconds",
                orElse: () =>
                  Effect.fail(
                    new ProcessTreeTestError({ message: "target did not receive SIGTERM" }),
                  ),
              }),
            );
            yield* owner.kill({ killSignal: "SIGKILL" });
            yield* Fiber.join(targetClosed).pipe(
              Effect.timeoutOrElse({
                duration: "3 seconds",
                orElse: () =>
                  Effect.fail(
                    new ProcessTreeTestError({ message: "target process tree did not close" }),
                  ),
              }),
            );
            yield* Fiber.join(descendantClosed).pipe(
              Effect.timeoutOrElse({
                duration: "3 seconds",
                orElse: () =>
                  Effect.fail(
                    new ProcessTreeTestError({ message: "descendant process tree did not close" }),
                  ),
              }),
            );
            yield* Fiber.interrupt(outputFiber);
          });
        }
      }),
    ),
  );

  it.live("terminates descendants after a native workload exits normally", () =>
    withPlatform(
      Effect.gen(function* () {
        let launcherPid: number | undefined;
        yield* Effect.gen(function* () {
          const descendantReady = yield* Deferred.make<number>();
          const workloadExited = yield* Deferred.make<void>();
          const descendantCode = `
          const net = require("node:net");
          const server = net.createServer();
          server.listen({ host: "127.0.0.1", port: 0 }, () => {
            const address = server.address();
            if (typeof address === "object" && address !== null) {
              process.stdout.write("DESC_READY " + address.port + "\\n");
            }
          });
        `;
          const targetCode = `
          const { spawn } = require("node:child_process");
          const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], {
            stdio: ["ignore", "pipe", "inherit"]
          });
          child.stdout.on("data", (chunk) => {
            process.stdout.write(chunk);
            if (chunk.toString().includes("DESC_READY ")) {
              process.stdout.write("DIRECT_EXITING\\n");
              process.exit(0);
            }
          });
          child.on("error", () => process.exit(1));
        `;
          const native = yield* spawnNativeProcess({
            executable: process.execPath,
            args: ["-e", targetCode],
          });
          launcherPid = Number(native.pid);
          const output = yield* native.stdout.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.runForEach((line) => {
              if (line.startsWith("DESC_READY ")) {
                return Deferred.succeed(
                  descendantReady,
                  Number.parseInt(line.slice("DESC_READY ".length), 10),
                );
              }
              if (line === "DIRECT_EXITING") return Deferred.succeed(workloadExited, undefined);
              return Effect.void;
            }),
            Effect.forkChild({ startImmediately: true }),
          );
          const port = yield* Deferred.await(descendantReady).pipe(Effect.timeout("5 seconds"));
          const socket = yield* NodeSocket.makeNet({ host: "127.0.0.1", port });
          const opened = yield* Deferred.make<void>();
          const closed = yield* socket
            .runRaw(() => Effect.void, { onOpen: Deferred.succeed(opened, undefined) })
            .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(opened).pipe(Effect.timeout("5 seconds"));
          yield* Deferred.await(workloadExited).pipe(Effect.timeout("5 seconds"));
          expect(yield* native.exitCode).toBe(0);
          yield* Fiber.join(closed).pipe(
            Effect.timeoutOrElse({
              duration: "5 seconds",
              orElse: () =>
                Effect.fail(
                  new ProcessTreeTestError({
                    message:
                      "native launcher left descendant listener alive after normal workload exit",
                  }),
                ),
            }),
          );
          yield* Fiber.interrupt(output);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (launcherPid !== undefined && process.platform !== "win32")
                spawnSync("kill", ["-KILL", `-${launcherPid}`], { stdio: "ignore" });
            }),
          ),
        );
      }),
    ),
  );
});
