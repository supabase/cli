import { NodeServices, NodeSocket } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Data, Deferred, Effect, Exit, Fiber, FileSystem, Path, Ref, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { LogStoreError, makeLogStore, type LogStore } from "../supervisor/LogStore.ts";
import type {
  DatabaseBootstrapOptions,
  DatabaseSession,
  DatabaseTransaction,
} from "../model/DatabaseBootstrap.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";
import { StackIdSchema } from "../public/StackId.ts";
import type { RuntimeWorkloadKey } from "./RuntimeDriver.ts";
import { RuntimeDriverError } from "./RuntimeDriver.ts";
import { makeNativeRuntime } from "./NativeRuntime.ts";
import { defaultNativeProcessLauncher, type NativeProcess } from "./NativeProcess.ts";

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
  restart: { maxAttempts: 1, backoffMs: 0 },
  artifacts: {
    native: { kind: "native", service: id, release: "test" },
    container: { kind: "container", service: id, image: `test/${id}` },
  },
  selected: { kind: "native", service: id, release: "test" },
  specHash: id,
});

const keyFor = (id: string): RuntimeWorkloadKey => ({
  stackId,
  desiredGeneration: 1,
  workloadId: `database:${id}`,
  specHash: id,
});

const fixtureProcess = (message: string) => ({
  executable: process.execPath,
  args: [
    "-e",
    `process.stdout.write(${JSON.stringify(`${message}\n`)}); process.stderr.write(${JSON.stringify("stderr\n")}); setInterval(() => {}, 1000)`,
  ],
});

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("native runtime", () => {
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
        let startedProcess: NativeProcess | undefined;
        const runtime = yield* makeNativeRuntime({
          resolveProcess: (_key, _entry) => Effect.succeed(fixtureProcess("secret-value")),
          logStore,
          waitForReadiness: (_key, _workload, process) =>
            Effect.sync(() => {
              startedProcess = process;
            }),
        });
        const key = keyFor("one");
        const logs = yield* logStore
          .stream({ follow: true })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
        const ready = yield* runtime.start(key, workload("one"));
        expect(ready.state).toBe("ready");
        const firstLog = (yield* Fiber.join(logs))[0];
        expect(firstLog?.message).toBe("[REDACTED]");
        const values = yield* runtime.observe(stackId);
        expect(values).toHaveLength(1);
        yield* runtime.stop(key);
        expect((yield* runtime.observe(stackId))[0]?.state).toBe("stopped");
        expect(startedProcess).toBeDefined();
        if (startedProcess !== undefined) expect(yield* startedProcess.isRunning).toBe(false);
        yield* runtime.remove(key);
        expect(yield* runtime.observe(stackId)).toEqual([]);
        expect((yield* logStore.read()).map((entry) => entry.message)).toContain("[REDACTED]");
      }),
    ),
  );

  it.live("cleans up when readiness fails", () =>
    withPlatform(
      Effect.gen(function* () {
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () => Effect.succeed(fixtureProcess("fails")),
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
            Effect.succeed({
              executable: process.execPath,
              args: ["-e", "process.stderr.write('native failed\\n'); process.exit(3)"],
            }),
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
              return fixtureProcess(`restart-${launches}`);
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
              return fixtureProcess("shared-start");
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
          retained: () => Effect.succeed([]),
          stream: () => Stream.empty,
        };
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () => Effect.succeed(fixtureProcess("log-failure")),
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
          retained: () => Effect.succeed([]),
          stream: () => Stream.empty,
        };
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () => Effect.succeed(fixtureProcess("log-failure-after-ready")),
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
        let applied = false;
        const session: DatabaseSession = {
          execute: () => Effect.void,
          transaction: (use) =>
            Effect.gen(function* () {
              let record = false;
              const transaction: DatabaseTransaction = {
                execute: (statement) =>
                  Effect.sync(() => {
                    if (statement.includes("INSERT INTO")) record = true;
                  }),
                setRolePassword: () => Effect.void,
                query: () => Effect.succeed(applied ? [{ revision: "fixture" }] : []),
              };
              yield* use(transaction);
              if (record) applied = true;
            }),
        };
        const bootstrap: DatabaseBootstrapOptions = {
          revisions: [{ id: "fixture", statement: "CREATE TABLE fixture" }],
        };
        const runtime = yield* makeNativeRuntime({
          resolveProcess: () => Effect.succeed(fixtureProcess("database")),
          waitForReadiness: () => Effect.void,
          resolveDatabaseSession: () => Effect.succeed(session),
          resolveDatabaseBootstrap: () => Effect.succeed(bootstrap),
        });
        const key = keyFor("bootstrap");
        const ready = yield* runtime.start(key, workload("bootstrap", "database"));
        expect(applied).toBe(true);
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
          resolveProcess: () => Effect.succeed(fixtureProcess("database")),
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

  it.live("isolates exact workload identities while stopping one", () =>
    withPlatform(
      Effect.gen(function* () {
        const runtime = yield* makeNativeRuntime({
          resolveProcess: (_key, entry) => Effect.succeed(fixtureProcess(entry.id)),
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
  // oxlint-disable effecttsgo/prefer-schema-over-json
  it.live("kills the native process tree when its owner pipe closes", () =>
    withPlatform(
      Effect.gen(function* () {
        const targetLauncher = defaultNativeProcessLauncher();
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
          const server = net.createServer();
          server.listen({ host: "127.0.0.1", port: 0 }, () => {
            const address = server.address();
            if (typeof address === "object" && address !== null) {
              process.stdout.write(\`TARGET_READY \${address.port}\\n\`);
            }
            const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], {
              stdio: ["ignore", "pipe", "inherit"]
            });
            child.stdout.on("data", (chunk) => process.stdout.write(chunk));
          });
        `;
        const ownerCode = `
          const { spawn } = require("node:child_process");
          const launcherProcess = spawn(${JSON.stringify(targetLauncher.command)}, ${JSON.stringify(targetLauncher.args)}, {
            detached: true,
            stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"]
          });
          launcherProcess.stdio[4].end(JSON.stringify({
            executable: process.execPath,
            args: ["-e", ${JSON.stringify(targetCode)}]
          }));
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
        const ready = yield* owner.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.takeUntil((line) => line.startsWith("DESC_READY ")),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        const output = yield* Fiber.join(ready).pipe(
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
        const lines = [...output];
        const targetLine = lines.find((line) => line.startsWith("TARGET_READY "));
        const descendantLine = lines.find((line) => line.startsWith("DESC_READY "));
        expect(targetLine).toBeDefined();
        expect(descendantLine).toBeDefined();
        const targetPort = Number.parseInt(targetLine?.slice("TARGET_READY ".length) ?? "", 10);
        const descendantPort = Number.parseInt(
          descendantLine?.slice("DESC_READY ".length) ?? "",
          10,
        );
        expect(Number.isSafeInteger(targetPort)).toBe(true);
        expect(Number.isSafeInteger(descendantPort)).toBe(true);
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
      }),
    ),
  );
  // oxlint-enable effecttsgo/prefer-schema-over-json
});
