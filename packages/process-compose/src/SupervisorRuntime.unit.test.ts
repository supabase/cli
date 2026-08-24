import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { layer as BunChildProcessSpawnerLayer } from "@effect/platform-bun/BunChildProcessSpawner";
import { layer as BunFileSystemLayer } from "@effect/platform-bun/BunFileSystem";
import { layer as BunPathLayer } from "@effect/platform-bun/BunPath";
import {
  Data,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { PlatformError } from "effect/PlatformError";
import { makeSupervisorRuntimeEnv, withoutSupervisorRuntimeEnv } from "./supervisor-protocol.ts";

const platformLayer = Layer.mergeAll(
  BunChildProcessSpawnerLayer.pipe(Layer.provide(Layer.mergeAll(BunFileSystemLayer, BunPathLayer))),
  BunFileSystemLayer,
  BunPathLayer,
);
const supervisorRuntimePath = fileURLToPath(new URL("./supervisor-runtime.ts", import.meta.url));
const supervisorProtocolPath = fileURLToPath(new URL("./supervisor-protocol.ts", import.meta.url));
type SupervisorEntry = "source path" | "compiled self-dispatch";

class TestFailure extends Data.TaggedError("TestFailure")<{
  readonly message: string;
}> {}

const spawnSupervisor = (entry: SupervisorEntry, encodedConfig: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    if (entry === "source path") {
      return yield* spawner.spawn(
        ChildProcess.make(process.execPath, [supervisorRuntimePath, encodedConfig], {
          stdin: "pipe",
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
    }
    const runtimeUrl = pathToFileURL(supervisorRuntimePath).href;
    const protocolUrl = pathToFileURL(supervisorProtocolPath).href;
    const dispatch = [
      `import { runSupervisorRuntimeFromEnv } from ${encodeJsonString(runtimeUrl)};`,
      `import { isSupervisorRuntimeRequested } from ${encodeJsonString(protocolUrl)};`,
      `if (!isSupervisorRuntimeRequested()) throw new Error("supervisor dispatch not requested");`,
      `runSupervisorRuntimeFromEnv();`,
    ].join("\n");
    return yield* spawner.spawn(
      ChildProcess.make(process.execPath, ["--eval", dispatch], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
        env: makeSupervisorRuntimeEnv(encodedConfig, {
          ...process.env,
          PROCESS_COMPOSE_SUPERVISOR_SELF_DISPATCH: "1",
        }),
      }),
    );
  });

const encodeJsonString = (value: string) =>
  Schema.encodeUnknownSync(Schema.fromJsonString(Schema.String))(value);
const jsonSchema = Schema.fromJsonString(Schema.Unknown);
const encodeJson = (value: unknown) => Schema.encodeUnknownSync(jsonSchema)(value);
const decodeJson = (value: string) => Schema.decodeSync(jsonSchema)(value);
const encodeConfig = (config: object) => Buffer.from(encodeJson(config)).toString("base64url");
const waitFor = <R>(
  condition: Effect.Effect<boolean, PlatformError, R>,
  description: string,
): Effect.Effect<void, PlatformError | TestFailure, R> =>
  condition.pipe(
    Effect.filterOrFail(
      (ready) => ready,
      () => new TestFailure({ message: `Timed out waiting for ${description}` }),
    ),
    Effect.retry(Schedule.spaced(Duration.millis(50))),
    Effect.timeoutOrElse({
      duration: Duration.seconds(10),
      orElse: () =>
        Effect.fail(new TestFailure({ message: `Timed out waiting for ${description}` })),
    }),
    Effect.asVoid,
  );

const waitForPath = (
  fs: FileSystem.FileSystem,
  directory: string,
  path: string,
  expected: boolean,
  description: string,
): Effect.Effect<void, PlatformError | TestFailure, FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* () {
      const watcher = yield* fs.watch(directory).pipe(
        Stream.filterEffect(() =>
          fs.exists(path).pipe(Effect.map((exists) => exists === expected)),
        ),
        Stream.runHead,
        Effect.asVoid,
        Effect.forkChild({ startImmediately: true }),
      );
      if ((yield* fs.exists(path)) === expected) {
        yield* Fiber.interrupt(watcher).pipe(Effect.ignore);
        return;
      }
      yield* Fiber.join(watcher).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(10),
          orElse: () =>
            Effect.fail(new TestFailure({ message: `Timed out waiting for ${description}` })),
        }),
      );
    }),
  );
const waitForExit = (supervisor: ChildProcessSpawner.ChildProcessHandle) =>
  supervisor.exitCode.pipe(Effect.exit, Effect.asVoid);
const closeStdin = (supervisor: ChildProcessSpawner.ChildProcessHandle) =>
  Stream.run(Stream.make(new Uint8Array()), supervisor.stdin).pipe(
    Effect.timeout(Duration.millis(100)),
    Effect.ignore,
    Effect.andThen(
      Effect.sync(() => {
        try {
          process.kill(supervisor.pid, "SIGTERM");
        } catch {}
      }),
    ),
  );
const isPidAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

describe("supervisor-runtime", () => {
  it.live.each<SupervisorEntry>(["source path", "compiled self-dispatch"])(
    "%s kills the child tree and runs validated orphan cleanup when parent stdin closes",
    (entry) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fs.makeTempDirectoryScoped({
            prefix: "process-compose-supervisor-",
          });
          const cleanupDir = path.join(tempDir, "cleanup-dir");
          const cleanupMarker = path.join(tempDir, "cleanup-command-ran");
          const cleanupEnvironmentMarker = path.join(tempDir, "cleanup-environment.json");
          const childPidFile = path.join(tempDir, "child.pid");
          const grandchildPidFile = path.join(tempDir, "grandchild.pid");
          const readyFile = path.join(tempDir, "ready");
          const childScriptPath = path.join(tempDir, "child.mjs");
          yield* fs.makeDirectory(cleanupDir);
          yield* fs.writeFileString(
            childScriptPath,
            [
              `import { spawn } from "node:child_process";`,
              `import { writeFileSync } from "node:fs";`,
              `writeFileSync(${encodeJsonString(childPidFile)}, String(process.pid));`,
              `const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
              `if (grandchild.pid != null) writeFileSync(${encodeJsonString(grandchildPidFile)}, String(grandchild.pid));`,
              `writeFileSync(${encodeJsonString(readyFile)}, "ready");`,
              `process.on("SIGTERM", () => {});`,
              `process.on("SIGINT", () => {});`,
              `setInterval(() => {}, 1000);`,
            ].join("\n"),
          );
          const encodedConfig = encodeConfig({
            command: process.execPath,
            args: [childScriptPath],
            shutdownSignal: "SIGTERM",
            shutdownTimeoutMs: 100,
            cleanup: [
              { _tag: "RemovePath", path: cleanupDir, recursive: true },
              {
                _tag: "RunCommand",
                executable: process.execPath,
                args: [
                  "-e",
                  [
                    `const { writeFileSync } = require("node:fs");`,
                    `writeFileSync(process.argv[1], process.argv[2]);`,
                    `writeFileSync(process.argv[3], JSON.stringify({ run: process.env.PROCESS_COMPOSE_RUN_SUPERVISOR, config: process.env.PROCESS_COMPOSE_SUPERVISOR_CONFIG, dispatch: process.env.PROCESS_COMPOSE_SUPERVISOR_SELF_DISPATCH }));`,
                  ].join("\n"),
                  cleanupMarker,
                  "literal; $(not-run) & value",
                  cleanupEnvironmentMarker,
                ],
              },
            ],
          });
          const supervisor = yield* spawnSupervisor(entry, encodedConfig);
          yield* waitForPath(fs, tempDir, readyFile, true, "child readiness");
          const childPid = Number.parseInt(yield* fs.readFileString(childPidFile), 10);
          const grandchildPid = Number.parseInt(yield* fs.readFileString(grandchildPidFile), 10);
          yield* closeStdin(supervisor);
          yield* waitForExit(supervisor);
          yield* waitForPath(fs, tempDir, cleanupMarker, true, "cleanup command marker");
          expect(yield* fs.readFileString(cleanupMarker)).toBe("literal; $(not-run) & value");
          expect(decodeJson(yield* fs.readFileString(cleanupEnvironmentMarker))).toEqual({});
          yield* waitForPath(fs, tempDir, cleanupDir, false, "cleanup removal");
          yield* waitFor(isPidAlive(childPid).pipe(Effect.map((alive) => !alive)), "child exit");
          yield* waitFor(
            isPidAlive(grandchildPid).pipe(Effect.map((alive) => !alive)),
            "grandchild exit",
          );
        }),
      ).pipe(Effect.provide(platformLayer)),
    { timeout: 15_000 },
  );

  it.live(
    "runs cleanup exactly once when graceful shutdown races with child exit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fs.makeTempDirectoryScoped({
            prefix: "process-compose-supervisor-race-",
          });
          const cleanupMarker = path.join(tempDir, "cleanup-runs");
          const readyFile = path.join(tempDir, "ready");
          const childScriptPath = path.join(tempDir, "child.mjs");
          yield* fs.writeFileString(
            childScriptPath,
            [
              `import { writeFileSync } from "node:fs";`,
              `writeFileSync(${encodeJsonString(readyFile)}, "ready");`,
              `process.on("SIGTERM", () => setTimeout(() => process.exit(0), 25));`,
              `setInterval(() => {}, 1000);`,
            ].join("\n"),
          );
          const supervisor = yield* spawnSupervisor(
            "source path",
            encodeConfig({
              command: process.execPath,
              args: [childScriptPath],
              shutdownSignal: "SIGTERM",
              shutdownTimeoutMs: 1_000,
              cleanup: [
                {
                  _tag: "RunCommand",
                  executable: process.execPath,
                  args: [
                    "-e",
                    `const { appendFileSync } = require("node:fs"); appendFileSync(${encodeJsonString(cleanupMarker)}, "cleanup\\n"); setTimeout(() => process.exit(0), 250);`,
                  ],
                },
              ],
            }),
          );
          yield* waitForPath(fs, tempDir, readyFile, true, "child readiness");
          yield* closeStdin(supervisor);
          yield* waitForExit(supervisor);
          expect(yield* fs.readFileString(cleanupMarker)).toBe("cleanup\n");
        }),
      ).pipe(Effect.provide(platformLayer)),
    { timeout: 12_000 },
  );

  it.live("exits successfully when graceful shutdown races with cleanup-less child exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({
          prefix: "process-compose-supervisor-exit-race-",
        });
        const readyFile = path.join(tempDir, "ready");
        const childScriptPath = path.join(tempDir, "child.mjs");
        yield* fs.writeFileString(
          childScriptPath,
          [
            `import { writeFileSync } from "node:fs";`,
            `writeFileSync(${encodeJsonString(readyFile)}, "ready");`,
            `setInterval(() => {}, 1000);`,
          ].join("\n"),
        );
        const supervisor = yield* spawnSupervisor(
          "source path",
          encodeConfig({
            command: process.execPath,
            args: [childScriptPath],
            shutdownSignal: "SIGTERM",
            shutdownTimeoutMs: 1_000,
          }),
        );
        yield* waitForPath(fs, tempDir, readyFile, true, "child readiness");
        yield* closeStdin(supervisor);
        yield* waitForExit(supervisor);
        expect(yield* supervisor.exitCode).toBe(0);
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it.live(
    "exits promptly with failure when the child dies by signal while the owner remains active",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fs.makeTempDirectoryScoped({
            prefix: "process-compose-supervisor-signal-",
          });
          const readyFile = path.join(tempDir, "ready");
          const childScriptPath = path.join(tempDir, "child.mjs");
          yield* fs.writeFileString(
            childScriptPath,
            [
              `import { writeFileSync } from "node:fs";`,
              `writeFileSync(${encodeJsonString(readyFile)}, "ready");`,
              `process.kill(process.pid, "SIGTERM");`,
            ].join("\n"),
          );
          const supervisor = yield* spawnSupervisor(
            "source path",
            encodeConfig({
              command: process.execPath,
              args: [childScriptPath],
              shutdownSignal: "SIGTERM",
              shutdownTimeoutMs: 100,
            }),
          );
          yield* waitForPath(fs, tempDir, readyFile, true, "child readiness");
          const exitCode = yield* supervisor.exitCode.pipe(Effect.timeout(Duration.seconds(5)));
          expect(exitCode).toBe(1);
        }),
      ).pipe(Effect.provide(platformLayer)),
    { timeout: 10_000 },
  );

  it.live.each([
    [
      "non-string command argument",
      { _tag: "RunCommand", executable: process.execPath, args: [42] },
    ],
    ["empty executable", { _tag: "RunCommand", executable: "", args: [] }],
    [
      "non-positive timeout",
      { _tag: "RunCommand", executable: process.execPath, args: [], timeoutMs: 0 },
    ],
    ["invalid path option", { _tag: "RemovePath", path: "/tmp/example", recursive: "yes" }],
  ] as const)("rejects a malformed cleanup contract with %s before spawning", ([_name, cleanup]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({
          prefix: "process-compose-supervisor-invalid-",
        });
        const childMarker = path.join(tempDir, "child-started");
        const supervisor = yield* spawnSupervisor(
          "source path",
          encodeConfig({
            command: process.execPath,
            args: [
              "-e",
              `require("node:fs").writeFileSync(${encodeJsonString(childMarker)}, "started")`,
            ],
            cleanup: [cleanup],
          }),
        );
        yield* waitForExit(supervisor);
        expect(yield* supervisor.exitCode).not.toBe(0);
        expect(yield* fs.exists(childMarker)).toBe(false);
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it("removes supervisor protocol variables from the managed child environment", () => {
    expect(
      withoutSupervisorRuntimeEnv({
        KEEP_ME: "value",
        PROCESS_COMPOSE_SUPERVISOR_SELF_DISPATCH: "1",
        PROCESS_COMPOSE_RUN_SUPERVISOR: "1",
        PROCESS_COMPOSE_SUPERVISOR_CONFIG: "encoded",
      }),
    ).toEqual({ KEEP_ME: "value" });
  });

  it.live("bounds a cleanup command tree by its timeout and continues remaining cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({
          prefix: "process-compose-supervisor-timeout-",
        });
        const cleanupDir = path.join(tempDir, "cleanup-dir");
        const cleanupWorkerPidFile = path.join(tempDir, "cleanup-worker.pid");
        const childScriptPath = path.join(tempDir, "child.mjs");
        yield* fs.makeDirectory(cleanupDir);
        yield* fs.writeFileString(childScriptPath, "process.exit(0);\n");
        const supervisor = yield* spawnSupervisor(
          "source path",
          encodeConfig({
            command: process.execPath,
            args: [childScriptPath],
            cleanup: [
              {
                _tag: "RunCommand",
                executable: process.execPath,
                args: [
                  "-e",
                  [
                    `const { spawn } = require("node:child_process");`,
                    `const { writeFileSync } = require("node:fs");`,
                    `const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
                    `writeFileSync(${encodeJsonString(cleanupWorkerPidFile)}, String(worker.pid));`,
                    `setInterval(() => {}, 1000);`,
                  ].join("\n"),
                ],
                timeoutMs: 2_000,
              },
              { _tag: "RemovePath", path: cleanupDir, recursive: true },
            ],
          }),
        );
        yield* waitForExit(supervisor);
        expect(yield* supervisor.exitCode).toBe(0);
        expect(yield* fs.exists(cleanupDir)).toBe(false);
        const cleanupWorkerPid = Number.parseInt(
          yield* fs.readFileString(cleanupWorkerPidFile),
          10,
        );
        expect(Number.isSafeInteger(cleanupWorkerPid)).toBe(true);
        yield* waitFor(
          isPidAlive(cleanupWorkerPid).pipe(Effect.map((alive) => !alive)),
          "cleanup worker exit",
        );
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

  it.live(
    "bounds a cleanup command when no timeout is configured",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fs.makeTempDirectoryScoped({
            prefix: "process-compose-supervisor-timeout-",
          });
          const cleanupDir = path.join(tempDir, "cleanup-dir");
          const cleanupPidFile = path.join(tempDir, "cleanup.pid");
          const childScriptPath = path.join(tempDir, "child.mjs");
          yield* fs.makeDirectory(cleanupDir);
          yield* fs.writeFileString(childScriptPath, "process.exit(0);\n");
          const supervisor = yield* spawnSupervisor(
            "source path",
            encodeConfig({
              command: process.execPath,
              args: [childScriptPath],
              cleanup: [
                {
                  _tag: "RunCommand",
                  executable: process.execPath,
                  args: [
                    "-e",
                    `require("node:fs").writeFileSync(${encodeJsonString(cleanupPidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
                  ],
                },
                { _tag: "RemovePath", path: cleanupDir, recursive: true },
              ],
            }),
          );
          yield* waitForExit(supervisor);
          expect(yield* supervisor.exitCode).toBe(0);
          expect(yield* fs.exists(cleanupDir)).toBe(false);
          const cleanupPid = Number.parseInt(yield* fs.readFileString(cleanupPidFile), 10);
          yield* Effect.sync(() => {
            try {
              process.kill(cleanupPid, "SIGKILL");
            } catch {}
          });
        }),
      ).pipe(Effect.provide(platformLayer)),
    { timeout: 12_000 },
  );

  it.live("runs orphan cleanup when the configured owner pid is already gone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({
          prefix: "process-compose-supervisor-",
        });
        const cleanupDir = path.join(tempDir, "cleanup-dir");
        const childScriptPath = path.join(tempDir, "child.mjs");
        yield* fs.makeDirectory(cleanupDir);
        yield* fs.writeFileString(childScriptPath, "setInterval(() => {}, 1000);\n");
        const supervisor = yield* spawnSupervisor(
          "source path",
          encodeConfig({
            command: process.execPath,
            args: [childScriptPath],
            ownerPid: 999_999_999,
            shutdownSignal: "SIGTERM",
            shutdownTimeoutMs: 100,
            cleanup: [{ _tag: "RemovePath", path: cleanupDir, recursive: true }],
          }),
        );
        yield* waitForExit(supervisor);
        yield* waitForPath(fs, tempDir, cleanupDir, false, "orphan cleanup");
      }),
    ).pipe(Effect.provide(platformLayer)),
  );
});
