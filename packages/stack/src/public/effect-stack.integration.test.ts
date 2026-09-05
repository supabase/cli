// oxlint-disable effecttsgo/prefer-schema-over-json -- malformed caller/state fixtures exercise public validation boundaries.
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Crypto,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  Path,
  Redacted,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";
import {
  defaultRuntimeEnvironment,
  ensureSupervisor,
  type StackRuntimeEnvironmentValue,
} from "../supervisor/Launcher.ts";
import {
  StackRuntimeEnvironment,
  acquireOwnership,
  ownerLockExists,
  publishOwnership,
  readOwnerMetadata,
} from "../state/Ownership.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import { makeStackStateStore } from "../state/StackStateStore.ts";
import { resolveSecrets } from "../state/SecretStore.ts";
import { deriveStackId, resolveStackIdentity } from "../identity/Identity.ts";
import { toPersistedIdentity, type PersistedStackState } from "../state/StackState.ts";
import { startControlServer } from "../control/ControlServer.ts";
import { STACK_RPC_RELEASE, type StackRpcHandlers } from "../control/StackRpc.ts";
import { compileStack } from "../model/Compiler.ts";
import { catalogEntryFor } from "../model/WorkloadCatalog.ts";
import {
  StackDestructionError,
  StackCleanupError,
  ContainerEngineError,
  InvalidStackConfigError,
  InvalidLogCursorError,
  StackLifecycleConflictError,
  StackOwnershipConflictError,
  StackPreparationError,
  StackRuntimeMismatchError,
  StackStateInvalidError,
  StackStateFormatUnsupportedError,
  StackNotFoundError,
  StackNotRunningError,
  StackVersionUnsupportedError,
  StackUpgradeRequiredError,
  type StackError,
} from "./Errors.ts";
import type { LogQuery, StackLogBatch, StackLogEntry } from "./Logs.ts";
import {
  createStack,
  inspectStack,
  listStacks,
  makeHandle,
  openStack,
  type EffectStack,
  type HandleDependencies,
  type PrepareStackResult,
} from "./EffectStack.ts";
import { CAPABILITY_NAMES } from "./Capability.ts";
import { StackIdSchema, type StackId } from "./StackId.ts";
import type { ArtifactPreparationStatus, StackStatus } from "./Status.ts";
import { makeDockerEngine } from "../runtime/DockerEngine.ts";
import {
  type ContainerCommandResult,
  type ContainerCommandRunner,
} from "../runtime/ContainerEngine.ts";
import { ContainerEngineResolver } from "../runtime/ContainerEngineResolver.ts";

const defaultDatabaseVersion = catalogEntryFor("database:database").defaultVersion;
const defaultDatabaseMajor = defaultDatabaseVersion.split(".")[0];
const defaultRestVersion = catalogEntryFor("rest:rest").defaultVersion;

const stackId = StackIdSchema.make(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);

const runningStatus: StackStatus = {
  id: stackId,
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {},
  versions: {},
  capabilities: CAPABILITY_NAMES.map((name) => ({
    name,
    activation: name === "functions" ? "lazy" : "eager",
    state: name === "pooler" ? "disabled" : "ready",
  })),
  artifacts: [],
};

const credentials = {
  database: { url: Redacted.make("postgres://localhost"), password: Redacted.make("secret") },
  api: {
    publishableKey: "publishable",
    secretKey: Redacted.make("secret"),
    anonJwt: "anon",
    serviceRoleJwt: Redacted.make("service"),
  },
};

const stoppedState = (): PersistedStackState => ({
  format: "supabase-stack-state-v1",
  identity: {
    stackId,
    projectRoot: "/tmp/project",
    checkoutRoot: "/tmp/project",
    workspaceId: "workspace",
    checkoutId: "checkout",
    branchContext: "branch",
    localProjectKey: "key",
    stackName: "stack",
  },
  runtime: { kind: "native" },
  desiredLifecycle: "stopped",
  ports: [],
  privatePorts: [],
  secrets: {},
});

const emptyLogs = () =>
  Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: false } as const);

const makeTestHandle = (id: StackId, overrides: Partial<HandleDependencies> = {}) =>
  makeHandle(id, {
    resolveOwner: () => Effect.succeed(Option.none()),
    readOfflineState: Effect.succeed(Option.none()),
    readPersistedState: Effect.succeed(Option.none()),
    readLogs: emptyLogs,
    waitForRelease: Effect.void,
    prepare: () =>
      Effect.fail(new StackPreparationError({ message: "test preparation unavailable" })),
    ...overrides,
  });

const withRuntimeRoot = <A, E, R>(effect: (project: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "supabase-effect-stack-owner-" });
      yield* Effect.addFinalizer(() =>
        fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore),
      );
      const project = path.join(root, "project");
      yield* fs.makeDirectory(project);
      const defaults = defaultRuntimeEnvironment();
      const runtime: StackRuntimeEnvironmentValue = {
        ...defaults,
        stateRoot: path.join(root, "managed", "stacks"),
        tempRoot: "/tmp",
        platform: "posix",
      };
      return yield* effect(project).pipe(Effect.provideService(StackRuntimeEnvironment, runtime));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

describe("Effect stack lifecycle handoff", () => {
  it.live("preserves stop cleanup error identity through maintenance transport", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-effect-stack-stop-error-",
        });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "stop-error-session";
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_001,
          rpcRelease: STACK_RPC_RELEASE,
        };
        const ownerScope = yield* Scope.make();
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          rpcHandlers: {
            status: () => Effect.succeed(runningStatus),
            credentials: () => Effect.succeed(credentials),
            start: () => Effect.succeed(runningStatus),
            destroy: () => Effect.void,
            logs: () => emptyLogs(),
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Effect.succeed({
              ok: false,
              error: {
                tag: "operation-failed",
                message: "injected stop cleanup failure",
                stackErrorTag: "StackCleanupError",
              },
            }),
          },
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: () => Effect.succeed(Option.some({ owner, launched: false })),
        });
        const stopped = yield* stack.stop().pipe(Effect.exit);
        expect(Exit.isFailure(stopped)).toBe(true);
        if (Exit.isFailure(stopped))
          expect(Option.getOrUndefined(Cause.findErrorOption(stopped.cause))).toBeInstanceOf(
            StackCleanupError,
          );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("hands off filtered logs through a real owner stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-effect-stack-logs-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "logs-session";
        const stopped = yield* Deferred.make<void>();
        const followRead = yield* Deferred.make<void>();
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        const initialAuth: StackLogEntry = {
          cursor: { opaque: "v1_1" },
          timestamp: "2026-01-01T00:00:00.000Z",
          source: "auth",
          stream: "stdout",
          message: "started",
        };
        const unrelatedDatabase: StackLogEntry = {
          cursor: { opaque: "v1_2" },
          timestamp: "2026-01-01T00:00:01.000Z",
          source: "database",
          stream: "stdout",
          message: "ignored",
        };
        const finalAuth: StackLogEntry = {
          cursor: { opaque: "v1_3" },
          timestamp: "2026-01-01T00:00:02.000Z",
          source: "auth",
          stream: "stdout",
          message: "stopped",
        };
        const logEntries = yield* Ref.make<ReadonlyArray<StackLogEntry>>([
          initialAuth,
          unrelatedDatabase,
        ]);
        const ownerRunning = yield* Ref.make(true);
        const ownerAvailable = yield* Ref.make(true);
        const readLogs = (query: LogQuery): Effect.Effect<StackLogBatch> =>
          Effect.gen(function* () {
            if (query.cursor !== undefined)
              yield* Deferred.succeed(followRead, undefined).pipe(Effect.asVoid);
            const allEntries = yield* Ref.get(logEntries);
            const cursorIndex =
              query.cursor === undefined
                ? -1
                : allEntries.findIndex((entry) => entry.cursor.opaque === query.cursor?.opaque);
            const capabilities = query.capabilities;
            const matching = allEntries
              .slice(cursorIndex + 1)
              .filter(
                (entry) =>
                  capabilities === undefined ||
                  (entry.source !== "gateway" &&
                    entry.source !== "supervisor" &&
                    capabilities.includes(entry.source)),
              );
            const entries =
              query.tail === undefined ? matching : matching.slice(-Math.floor(query.tail));
            const cursor = allEntries.at(-1)?.cursor ?? { opaque: "v1_0" };
            return {
              entries,
              cursor,
              running: yield* Ref.get(ownerRunning),
            };
          });
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_001,
          rpcRelease: STACK_RPC_RELEASE,
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcHandlers: {
            status: () => Effect.succeed(runningStatus),
            credentials: () => Effect.succeed(credentials),
            start: () => Effect.succeed(runningStatus),
            destroy: () => Effect.void,
            logs: (query) => readLogs(query),
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Effect.gen(function* () {
              yield* Ref.set(ownerRunning, false);
              yield* Ref.update(logEntries, (entries) => [...entries, finalAuth]);
              yield* Deferred.succeed(stopped, undefined);
              return { ok: true, op: "stop" } as const;
            }),
          },
          onShutdownReady: Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: () =>
            Ref.get(ownerAvailable).pipe(
              Effect.map((available) =>
                available ? Option.some({ owner, launched: false }) : Option.none(),
              ),
            ),
          readOfflineState: Effect.succeed(Option.some(stoppedState())),
        });
        expect((yield* stack.start()).lifecycle).toBe("running");
        const first = yield* stack.logs({ capabilities: ["auth"], tail: 1 });
        expect(first.entries).toEqual([initialAuth]);
        expect(first.cursor).toEqual(unrelatedDatabase.cursor);

        const followedFiber = yield* Effect.forkChild(
          stack
            .followLogs({ capabilities: ["auth"], cursor: first.cursor })
            .pipe(Stream.runCollect),
          { startImmediately: true },
        );
        yield* Deferred.await(followRead);
        const stopFiber = yield* Effect.forkChild(stack.stop(), { startImmediately: true });
        yield* Deferred.await(stopped);
        const followed = yield* Fiber.join(followedFiber);
        expect(Array.from(followed)).toEqual([finalAuth]);
        yield* Ref.set(ownerAvailable, false);
        yield* Scope.close(ownerScope, Exit.void);
        yield* Fiber.join(stopFiber);
        expect((yield* stack.status()).lifecycle).toBe("stopped");
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("propagates malformed log cursors through the public control handle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-effect-stack-cursor-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "cursor-session";
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_001,
          rpcRelease: STACK_RPC_RELEASE,
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcHandlers: {
            status: () => Effect.succeed(runningStatus),
            credentials: () => Effect.succeed(credentials),
            start: () => Effect.succeed(runningStatus),
            destroy: () => Effect.void,
            logs: () =>
              Effect.fail({ tag: "InvalidLogCursorError", message: "Log cursor is invalid" }),
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Effect.succeed({ ok: true, op: "stop" }),
          },
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: () => Effect.succeed(Option.some({ owner, launched: false })),
        });
        const result = yield* stack.logs({ cursor: { opaque: "not-a-cursor" } }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Option.getOrUndefined(Cause.findErrorOption(result.cause))).toBeInstanceOf(
            InvalidLogCursorError,
          );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("delivers final followed entries once and completes after stop", () =>
    withRuntimeRoot((_project) =>
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- test-only handle seam
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const entries: [StackLogEntry, StackLogEntry, StackLogEntry, StackLogEntry] = [
          {
            cursor: { opaque: "v1_1" },
            timestamp: "2026-01-01T00:00:00.000Z",
            source: "auth" as const,
            stream: "stdout" as const,
            message: "started",
          },
          {
            cursor: { opaque: "v1_2" },
            timestamp: "2026-01-01T00:00:01.000Z",
            source: "auth" as const,
            stream: "stdout" as const,
            message: "stopped",
          },
          {
            cursor: { opaque: "v1_3" },
            timestamp: "2026-01-01T00:00:02.000Z",
            source: "auth" as const,
            stream: "stdout" as const,
            message: "drained",
          },
          {
            cursor: { opaque: "v1_4" },
            timestamp: "2026-01-01T00:00:03.000Z",
            source: "auth" as const,
            stream: "stdout" as const,
            message: "closed",
          },
        ];
        const burst = entries.slice(1);
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: () => Effect.succeed(Option.none()),
          readPersistedState: Effect.succeed(Option.some(stoppedState())),
          readOfflineState: Effect.succeed(Option.none()),
          readLogs: (query?: LogQuery) =>
            Ref.getAndUpdate(calls, (current) => current + 1).pipe(
              Effect.map((index) => {
                const batchEntries = index === 0 ? [entries[0]] : burst;
                const visibleEntries =
                  query?.tail === undefined
                    ? batchEntries
                    : batchEntries.slice(-Math.floor(query.tail));
                return {
                  entries: visibleEntries,
                  cursor: entries.at(index === 0 ? 0 : 3)?.cursor ?? { opaque: "v1_0" },
                  running: index === 0,
                };
              }),
            ),
        });
        const followed = yield* stack
          .followLogs({ capabilities: ["auth"], tail: 1 })
          .pipe(Stream.runCollect, Effect.exit);
        expect(Exit.isSuccess(followed)).toBe(true);
        if (Exit.isSuccess(followed)) expect(Array.from(followed.value)).toEqual(entries);
        expect(yield* Ref.get(calls)).toBe(2);
      }),
    ),
  );

  it.live("creates a stopped stack without launching a Supervisor", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const env = yield* StackRuntimeEnvironment;
        const stack = yield* createStack({ projectRoot: project });
        expect(yield* readOwnerMetadata(env.stateRoot, stack.id, env)).toBeUndefined();
        const offline = yield* stack.status();
        expect(offline.lifecycle).toBe("unconfigured");
        expect(offline.capabilities.every(({ state }) => state === "disabled")).toBe(true);
        yield* openStack(stack.id);
        expect(yield* readOwnerMetadata(env.stateRoot, stack.id, env)).toBeUndefined();
        yield* stack.stop();
        expect((yield* stack.status()).lifecycle).toBe("unconfigured");
        expect((yield* stack.logs()).entries).toHaveLength(0);
      }),
    ),
  );

  it.live("releases a temporary Supervisor after a pre-commit start failure", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const env = yield* StackRuntimeEnvironment;
        const stack = yield* createStack({ projectRoot: project, runtime: { kind: "native" } });
        const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
        const state = yield* store.read(stack.id);
        if (state === undefined) return yield* Effect.die("stack state was not initialized");
        yield* store.replace(stack.id, { ...state, desiredLifecycle: "stopped" });

        const started = yield* stack
          .start({ config: { capabilities: { database: { version: "unsupported" } } } })
          .pipe(Effect.exit);

        expect(Exit.isFailure(started)).toBe(true);
        expect(yield* readOwnerMetadata(env.stateRoot, stack.id, env)).toBeUndefined();
        expect(yield* ownerLockExists(env.stateRoot, stack.id)).toBe(false);
        expect((yield* stack.status()).lifecycle).toBe("stopped");
        const reopened = yield* openStack(stack.id);
        expect((yield* reopened.status()).lifecycle).toBe("stopped");
      }),
    ),
  );

  it.live("never projects offline state while metadata or the ownership lock remains", () =>
    Effect.gen(function* () {
      for (const artifact of ["metadata", "lock"] as const) {
        const ownership = new StackOwnershipConflictError({
          message: `owner ${artifact} is still present`,
        });
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: () => Effect.succeed(Option.none()),
          readOfflineState: Effect.fail(ownership),
          readLogs: () => Effect.fail(ownership),
        });
        const status = yield* stack.status().pipe(Effect.exit);
        expect(Exit.isFailure(status)).toBe(true);
        const logs = yield* stack.logs().pipe(Effect.exit);
        expect(Exit.isFailure(logs)).toBe(true);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("preserves an unreachable owner error when offline status is still guarded", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint: { kind: "unix" as const, path: path.join(project, "missing-owner.sock") },
          ownerSessionId: "unreachable-owner",
          leasePort: 45_001,
          rpcRelease: STACK_RPC_RELEASE,
        };
        let ownerReads = 0;
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: () =>
            Effect.sync(() => {
              ownerReads += 1;
              return ownerReads === 1 ? Option.some({ owner, launched: false }) : Option.none();
            }),
          readOfflineState: Effect.fail(
            new StackOwnershipConflictError({ message: "Owner metadata still exists" }),
          ),
        });
        const result = yield* stack.status().pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          expect(error).toBeInstanceOf(StackOwnershipConflictError);
          expect(error?.message).toContain("Stack owner is unreachable");
        }
      }),
    ),
  );

  it.live("waits for owner teardown before falling back to offline logs", () =>
    withRuntimeRoot((_project) =>
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0);
        const ownership = new StackOwnershipConflictError({
          message: "Supervisor is still shutting down",
        });
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: () => Effect.succeed(Option.none()),
          readPersistedState: Effect.succeed(Option.some(stoppedState())),
          readLogs: () =>
            Ref.getAndUpdate(attempts, (current) => current + 1).pipe(
              Effect.flatMap((attempt) =>
                attempt === 0
                  ? Effect.fail(ownership)
                  : Effect.succeed({
                      entries: [],
                      cursor: { opaque: "v1_0" },
                      running: false,
                    }),
              ),
            ),
        });
        const batch = yield* stack.logs();
        expect(batch.entries).toEqual([]);
        expect(yield* Ref.get(attempts)).toBe(2);
      }),
    ),
  );

  it.live("preserves an allowed error tag when reading offline logs", () =>
    Effect.gen(function* () {
      const upgrade = new StackUpgradeRequiredError({
        message: "The retained log protocol is newer than this client",
        expectedRelease: STACK_RPC_RELEASE,
        actualRelease: "future",
      });
      const stack = yield* makeTestHandle(stackId, {
        resolveOwner: () => Effect.succeed(Option.none()),
        readPersistedState: Effect.succeed(Option.some(stoppedState())),
        readLogs: () => Effect.fail(upgrade),
      });
      const result = yield* stack.logs().pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Option.getOrUndefined(Cause.findErrorOption(result.cause))).toBe(upgrade);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "guards offline operations against real lock-only and metadata ownership",
    () =>
      withRuntimeRoot((project) =>
        Effect.gen(function* () {
          const env = yield* StackRuntimeEnvironment;
          const stack = yield* createStack({ projectRoot: project });
          const lease = yield* acquireOwnership({
            stateRoot: env.stateRoot,
            stackId: stack.id,
            ownerSessionId: "offline-guard",
            rpcRelease: STACK_RPC_RELEASE,
            environment: env,
          });
          const assertGuarded = (candidate: EffectStack) =>
            Effect.gen(function* () {
              expect(Exit.isFailure(yield* candidate.status().pipe(Effect.exit))).toBe(true);
              expect(Exit.isFailure(yield* candidate.logs().pipe(Effect.exit))).toBe(true);
            });
          const lockOnly = yield* openStack(stack.id);
          expect(yield* ownerLockExists(env.stateRoot, stack.id)).toBe(true);
          expect(yield* readOwnerMetadata(env.stateRoot, stack.id, env)).toBeUndefined();
          expect((yield* inspectStack(stack.id)).owner).toBe("unreachable");
          yield* assertGuarded(lockOnly);
          yield* lease.release;

          const metadataLease = yield* acquireOwnership({
            stateRoot: env.stateRoot,
            stackId: stack.id,
            ownerSessionId: "offline-metadata",
            rpcRelease: STACK_RPC_RELEASE,
            environment: env,
          });
          yield* publishOwnership(metadataLease);
          const metadataOnly = yield* openStack(stack.id);
          expect(yield* readOwnerMetadata(env.stateRoot, stack.id, env)).toBeDefined();
          yield* assertGuarded(metadataOnly);
        }),
      ),
    60_000,
  );

  it.live("prepares cache-only without an owner or state mutation", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const env = yield* StackRuntimeEnvironment;
        const stack = yield* createStack({ projectRoot: project });
        const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
        const state = yield* store.read(stack.id);
        if (state === undefined) return yield* Effect.die("stack state was not initialized");
        const paths = yield* resolveStackPaths({ stateRoot: env.stateRoot, stackId: stack.id });
        const before = yield* (yield* FileSystem.FileSystem).readFileString(paths.stateDocument);
        const prepared = yield* stack.prepare({ capabilities: [] });
        expect(prepared.capabilities).toEqual([]);
        expect(yield* readOwnerMetadata(env.stateRoot, stack.id, env)).toBeUndefined();
        expect(yield* ownerLockExists(env.stateRoot, stack.id)).toBe(false);
        expect(yield* (yield* FileSystem.FileSystem).readFileString(paths.stateDocument)).toBe(
          before,
        );
      }),
    ),
  );

  it.live("applies the configured artifact cache root during handle preparation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-effect-stack-cache-" });
        const project = path.join(root, "project");
        yield* fs.makeDirectory(project);
        const defaults = defaultRuntimeEnvironment();
        const stateRoot = path.join(root, "managed", "stacks");
        const artifactCacheRoot = path.join(root, "shared-artifacts");
        const configuredEnvironment: StackRuntimeEnvironmentValue = {
          ...defaults,
          stateRoot,
          artifactCacheRoot,
        };
        const stack = yield* createStack({
          projectRoot: project,
          runtime: { kind: "native" },
        }).pipe(Effect.provideService(StackRuntimeEnvironment, configuredEnvironment));
        const prepared = yield* stack.prepare({ capabilities: [] });
        expect(prepared.capabilities).toEqual([]);
        expect(yield* fs.exists(artifactCacheRoot)).toBe(true);
        expect(yield* fs.exists(path.join(stateRoot, "artifacts"))).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("preserves input and version errors from prepare", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const stack = yield* createStack({ projectRoot: project, runtime: { kind: "native" } });
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- exercise unknown caller input
        const invalid = yield* stack
          .prepare({
            config: JSON.parse('{"capabilities":{"rest":{"settings":{"unknown":true}}}}'),
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(invalid)).toBe(true);
        if (Exit.isFailure(invalid))
          expect(Option.getOrUndefined(Cause.findErrorOption(invalid.cause))).toBeInstanceOf(
            InvalidStackConfigError,
          );

        const unsupported = yield* stack
          .prepare({ config: { capabilities: { database: { version: "99" } } } })
          .pipe(Effect.exit);
        expect(Exit.isFailure(unsupported)).toBe(true);
        if (Exit.isFailure(unsupported))
          expect(Option.getOrUndefined(Cause.findErrorOption(unsupported.cause))).toBeInstanceOf(
            StackVersionUnsupportedError,
          );
      }),
    ),
  );

  it.live("preserves unsupported persisted state format from prepare and start", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const env = yield* StackRuntimeEnvironment;
        const stack = yield* createStack({ projectRoot: project });
        const paths = yield* resolveStackPaths({ stateRoot: env.stateRoot, stackId: stack.id });
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- malformed persisted state fixture
        yield* fs.writeFileString(
          paths.stateDocument,
          JSON.stringify({ format: "supabase-stack-v0" }),
        );

        const result = yield* stack.prepare().pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Option.getOrUndefined(Cause.findErrorOption(result.cause))).toBeInstanceOf(
            StackStateFormatUnsupportedError,
          );

        const started = yield* stack.start().pipe(Effect.exit);
        expect(Exit.isFailure(started)).toBe(true);
        if (Exit.isFailure(started))
          expect(Option.getOrUndefined(Cause.findErrorOption(started.cause))).toBeInstanceOf(
            StackStateFormatUnsupportedError,
          );
      }),
    ),
  );

  it.live("reports a retained handle as not found after destroy", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const stack = yield* createStack({ projectRoot: project });
        yield* stack.destroy();

        const status = yield* stack.status().pipe(Effect.exit);
        expect(Exit.isFailure(status)).toBe(true);
        if (Exit.isFailure(status))
          expect(Option.getOrUndefined(Cause.findErrorOption(status.cause))).toBeInstanceOf(
            StackNotFoundError,
          );
        const logs = yield* stack.logs().pipe(Effect.exit);
        expect(Exit.isFailure(logs)).toBe(true);
        if (Exit.isFailure(logs))
          expect(Option.getOrUndefined(Cause.findErrorOption(logs.cause))).toBeInstanceOf(
            StackNotFoundError,
          );
      }),
    ),
  );

  it.live("classifies credentials for offline and unreachable stacks", () =>
    Effect.gen(function* () {
      const stopped = yield* makeTestHandle(stackId, {
        readOfflineState: Effect.succeed(Option.some(stoppedState())),
      });
      const stoppedResult = yield* stopped.credentials().pipe(Effect.exit);
      expect(Exit.isFailure(stoppedResult)).toBe(true);
      if (Exit.isFailure(stoppedResult)) {
        const error = Cause.findErrorOption(stoppedResult.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) expect(error.value).toBeInstanceOf(StackNotRunningError);
      }

      const missing = yield* makeTestHandle(stackId);
      const missingResult = yield* missing.credentials().pipe(Effect.exit);
      expect(Exit.isFailure(missingResult)).toBe(true);
      if (Exit.isFailure(missingResult)) {
        const error = Cause.findErrorOption(missingResult.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) expect(error.value).toBeInstanceOf(StackNotFoundError);
      }

      const running = yield* makeTestHandle(stackId, {
        readOfflineState: Effect.succeed(
          Option.some({ ...stoppedState(), desiredLifecycle: "running" }),
        ),
      });
      const runningResult = yield* running.credentials().pipe(Effect.exit);
      expect(Exit.isFailure(runningResult)).toBe(true);
      if (Exit.isFailure(runningResult)) {
        const error = Cause.findErrorOption(runningResult.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) expect(error.value).toBeInstanceOf(StackOwnershipConflictError);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("does not leave a runtime remnant when a retained handle starts after destroy", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const env = yield* StackRuntimeEnvironment;
        const stack = yield* createStack({ projectRoot: project });
        yield* stack.destroy();
        const paths = yield* resolveStackPaths({ stateRoot: env.stateRoot, stackId: stack.id });

        const failed = yield* stack.start().pipe(Effect.exit);

        expect(Exit.isFailure(failed)).toBe(true);
        expect(yield* fs.exists(paths.stackRoot)).toBe(false);
        expect(yield* listStacks()).toEqual([]);
      }),
    ),
  );

  it.live("ignores a runtime-only missing-state sibling during list discovery", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const env = yield* StackRuntimeEnvironment;
        const valid = yield* createStack({ projectRoot: project });
        const orphanId = StackIdSchema.make("a".repeat(64));
        const orphanPaths = yield* resolveStackPaths({
          stateRoot: env.stateRoot,
          stackId: orphanId,
        });
        yield* fs.makeDirectory(orphanPaths.runtime, { recursive: true });

        const listed = yield* listStacks();

        expect(listed).toHaveLength(1);
        expect(listed[0]?.id).toBe(valid.id);
      }),
    ),
  );

  it.live("recovers a same-identity runtime-only missing-state remnant during create", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const env = yield* StackRuntimeEnvironment;
        const identity = yield* resolveStackIdentity({ projectRoot: project });
        const id = yield* deriveStackId(identity);
        const paths = yield* resolveStackPaths({ stateRoot: env.stateRoot, stackId: id });
        yield* fs.makeDirectory(paths.runtime, { recursive: true });

        const recovered = yield* createStack({ projectRoot: project });

        expect(recovered.id).toBe(id);
        expect(yield* fs.exists(paths.stateDocument)).toBe(true);
      }),
    ),
  );

  it.live("keeps durable missing-state remnants fail-closed during list discovery", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const env = yield* StackRuntimeEnvironment;
        yield* createStack({ projectRoot: project });
        const orphanId = StackIdSchema.make("b".repeat(64));
        const orphanPaths = yield* resolveStackPaths({
          stateRoot: env.stateRoot,
          stackId: orphanId,
        });
        yield* fs.makeDirectory(orphanPaths.data, { recursive: true });

        const listed = yield* listStacks().pipe(Effect.exit);

        expect(Exit.isFailure(listed)).toBe(true);
        expect(
          Exit.isFailure(listed)
            ? Option.getOrUndefined(Cause.findErrorOption(listed.cause))
            : undefined,
        ).toBeInstanceOf(StackStateInvalidError);
      }),
    ),
  );

  it.live("treats an omitted container engine as Docker for runtime identity", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        yield* createStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "podman" },
        });
        const result = yield* createStack({
          projectRoot: project,
          runtime: { kind: "container" },
        }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const failure = Cause.findErrorOption(result.cause);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure))
            expect(failure.value).toBeInstanceOf(StackRuntimeMismatchError);
        }
      }),
    ),
  );

  it.live("rejects unknown capabilities as a typed preparation error", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const stack = yield* createStack({ projectRoot: project });
        const malformedOptions = { capabilities: ["not-a-capability"] };
        const malformedPrepare = (): Effect.Effect<PrepareStackResult, StackPreparationError> =>
          Reflect.apply(stack.prepare, stack, [malformedOptions]);
        const result = yield* malformedPrepare().pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const failure = Cause.findErrorOption(result.cause);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) expect(failure.value).toBeInstanceOf(StackPreparationError);
        }
      }),
    ),
  );

  it.live("rejects a disabled capability before preparing artifacts", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const stack = yield* createStack({ projectRoot: project });
        const result = yield* stack
          .prepare({
            config: { capabilities: { pooler: { enabled: false } } },
            capabilities: ["pooler"],
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const failure = Cause.findErrorOption(result.cause);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) expect(failure.value).toBeInstanceOf(StackPreparationError);
        }
      }),
    ),
  );

  it.live("uses persisted pins and dependency closure for prospective preparation", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const env = yield* StackRuntimeEnvironment;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const calls: Array<string> = [];
        const runner: ContainerCommandRunner = {
          run: (request) => {
            calls.push(request.args.slice(0, 3).join(" "));
            if (request.args[0] === "version")
              return Effect.succeed<ContainerCommandResult>({
                stdout: '"1"\n',
                stderr: "",
                exitCode: 0,
              });
            if (request.args[0] === "image" && request.args[1] === "ls")
              return Effect.succeed<ContainerCommandResult>({
                stdout: '"cached"\n',
                stderr: "",
                exitCode: 0,
              });
            return Effect.succeed<ContainerCommandResult>({ stdout: "", stderr: "", exitCode: 0 });
          },
          stream: () => Stream.empty,
        };
        const engine = makeDockerEngine({ runner, platform: { os: "linux" } });
        const stack = yield* createStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "docker" },
        }).pipe(
          Effect.provideService(ContainerEngineResolver, {
            resolve: () => Effect.succeed(engine),
          }),
        );
        const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
        const state = yield* store.read(stack.id);
        if (state === undefined) return yield* Effect.die("stack state was not initialized");
        const persisted = yield* compileStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "docker" },
          config: { capabilities: { database: { version: defaultDatabaseMajor } } },
        }).pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(Crypto.Crypto, crypto),
        );
        yield* store.replace(stack.id, {
          ...state,
          definition: persisted.definition,
        });
        const before = yield* stack.status();
        const progress: Array<ArtifactPreparationStatus> = [];
        const prepared = yield* stack.prepare({
          config: { capabilities: { rest: { settings: { schemas: ["private"] } } } },
          capabilities: ["rest"],
          onProgress: (status) => progress.push(status),
        });
        expect(prepared.capabilities).toEqual([
          { capability: "database", version: defaultDatabaseVersion, outcome: "cached" },
          { capability: "rest", version: defaultRestVersion, outcome: "cached" },
        ]);
        expect(calls.filter((call) => call.startsWith("image ls"))).toHaveLength(2);
        expect(progress).toEqual(
          expect.arrayContaining([
            { workloadId: "database:database", capability: "database", state: "queued" },
            { workloadId: "rest:rest", capability: "rest", state: "queued" },
            { workloadId: "database:database", capability: "database", state: "preparing" },
            { workloadId: "rest:rest", capability: "rest", state: "preparing" },
            { workloadId: "database:database", capability: "database", state: "ready" },
            { workloadId: "rest:rest", capability: "rest", state: "ready" },
          ]),
        );
        expect(yield* stack.status()).toEqual(before);
      }),
    ),
  );

  it.live(
    "surfaces a container engine failure during public start",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-effect-stack-start-",
          });
          const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
          const ownerSessionId = "start-error-session";
          const ownerScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
          const owner = {
            format: "supabase-stack-owner-v1" as const,
            stackId,
            endpoint,
            ownerSessionId,
            leasePort: 45_001,
            rpcRelease: STACK_RPC_RELEASE,
          };
          yield* startControlServer({
            endpoint,
            stackId,
            ownerSessionId,
            rpcHandlers: {
              status: () => Effect.succeed(runningStatus),
              credentials: () => Effect.succeed(credentials),
              start: () =>
                Effect.fail({
                  tag: "ContainerEngineError",
                  message: "Container engine command failed while starting database",
                }),
              destroy: () => Effect.void,
              logs: () => emptyLogs(),
            },
            maintenanceHandlers: {
              probe: Effect.succeed({
                ok: true,
                op: "probe",
                stackId,
                ownerSessionId,
                rpcRelease: STACK_RPC_RELEASE,
              }),
              stop: Effect.succeed({ ok: true, op: "stop" }),
            },
          }).pipe(Effect.provideService(Scope.Scope, ownerScope));
          const stack = yield* makeTestHandle(stackId, {
            resolveOwner: () => Effect.succeed(Option.some({ owner, launched: false })),
          });
          const result = yield* stack.start().pipe(Effect.exit);
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            const failure = Cause.findErrorOption(result.cause);
            expect(Option.isSome(failure)).toBe(true);
            if (Option.isSome(failure)) {
              expect(failure.value).toBeInstanceOf(ContainerEngineError);
              expect(failure.value.message).toContain("Container engine command failed");
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    240_000,
  );

  it.live("surfaces concurrent lifecycle conflicts through the public start handle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "ss-cstart-",
        });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "concurrent-start-session";
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        const startEntered = yield* Deferred.make<void>();
        const releaseStart = yield* Deferred.make<void>();
        let starts = 0;
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_001,
          rpcRelease: STACK_RPC_RELEASE,
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcHandlers: {
            status: () => Effect.succeed(runningStatus),
            credentials: () => Effect.succeed(credentials),
            start: () =>
              Effect.gen(function* () {
                starts += 1;
                if (starts === 1) {
                  yield* Deferred.succeed(startEntered, undefined);
                  yield* Deferred.await(releaseStart);
                  return runningStatus;
                }
                return yield* Effect.fail({
                  tag: "StackLifecycleConflictError",
                  message: "A lifecycle transition is already in progress",
                } as const);
              }),
            destroy: () => Effect.void,
            logs: () => emptyLogs(),
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Effect.succeed({ ok: true, op: "stop" }),
          },
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: () => Effect.succeed(Option.some({ owner, launched: false })),
        });
        const first = yield* Effect.forkChild(stack.start(), { startImmediately: true });
        yield* Deferred.await(startEntered);
        const second = yield* stack.start().pipe(Effect.exit);
        expect(Exit.isFailure(second)).toBe(true);
        if (Exit.isFailure(second)) {
          const failure = Cause.findErrorOption(second.cause);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure))
            expect(failure.value).toBeInstanceOf(StackLifecycleConflictError);
        }
        yield* Deferred.succeed(releaseStart, undefined);
        expect(Exit.isSuccess(yield* Fiber.join(first).pipe(Effect.exit))).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("cancels unfinished direct preparation while retaining completed artifacts", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const env = yield* StackRuntimeEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const crypto = {
          ...(yield* Effect.service(Crypto.Crypto)),
          randomBytes: () => {
            throw new Error("direct preparation must not generate managed secrets");
          },
        } satisfies Crypto.Crypto;
        const firstPublished = yield* Deferred.make<void>();
        const secondDownloadStarted = yield* Deferred.make<void>();
        const secondDownloadCancelled = yield* Deferred.make<void>();
        const secondDownloadRelease = yield* Deferred.make<void>();
        const present = new Set<string>();
        const runner: ContainerCommandRunner = {
          run: (request) => {
            const [command, subcommand, image] = request.args;
            if (command === "version")
              return Effect.succeed<ContainerCommandResult>({
                stdout: '"1"\n',
                stderr: "",
                exitCode: 0,
              });
            if (command === "image" && subcommand === "ls" && image !== undefined) {
              return Effect.succeed({
                stdout: present.has(image) ? '"cached"\n' : "",
                stderr: "",
                exitCode: 0,
              });
            }
            if (
              command === "image" &&
              subcommand === "pull" &&
              image !== undefined &&
              image.includes("postgrest")
            )
              return Deferred.succeed(secondDownloadStarted, undefined).pipe(
                Effect.andThen(Deferred.await(secondDownloadRelease)),
                Effect.onInterrupt(() =>
                  Deferred.succeed(secondDownloadCancelled, undefined).pipe(Effect.asVoid),
                ),
                Effect.as({ stdout: "", stderr: "", exitCode: 0 }),
              );
            if (command === "image" && subcommand === "pull" && image !== undefined)
              return Effect.yieldNow.pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    present.add(image);
                    return { stdout: "", stderr: "", exitCode: 0 };
                  }),
                ),
                Effect.andThen(
                  image.includes("postgres")
                    ? Deferred.succeed(firstPublished, undefined)
                    : Effect.void,
                ),
                Effect.as({ stdout: "", stderr: "", exitCode: 0 }),
              );
            return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
          },
          stream: () => Stream.empty,
        };
        const engine = makeDockerEngine({
          runner,
          platform: { os: "linux" },
        });
        const resolver = {
          resolve: () => Effect.succeed(engine),
        };
        const stack = yield* createStack({
          projectRoot: project,
          runtime: { kind: "container", engine: "docker" },
        }).pipe(
          Effect.provideService(ContainerEngineResolver, resolver),
          Effect.provideService(Crypto.Crypto, crypto),
        );
        const stateStore = yield* makeStackStateStore({ stateRoot: env.stateRoot });
        const paths = yield* resolveStackPaths({ stateRoot: env.stateRoot, stackId: stack.id });
        const before = yield* fs.readFileString(paths.stateDocument);
        const progress: Array<ArtifactPreparationStatus> = [];
        const preparation = yield* Effect.forkChild(
          stack.prepare({
            capabilities: ["database", "rest"],
            onProgress: (status) => progress.push(status),
          }),
          { startImmediately: true },
        );
        yield* Deferred.await(firstPublished).pipe(Effect.timeout("5 seconds"), Effect.orDie);
        yield* Deferred.await(secondDownloadStarted).pipe(
          Effect.timeout("5 seconds"),
          Effect.orDie,
        );
        expect(
          progress.some(
            ({ workloadId, state }) => workloadId === "rest:rest" && state === "downloading",
          ),
        ).toBe(true);
        yield* Fiber.interrupt(preparation);
        yield* Deferred.await(secondDownloadCancelled).pipe(
          Effect.timeout("5 seconds"),
          Effect.orDie,
        );
        const canceled = yield* Fiber.join(preparation).pipe(Effect.exit);
        expect(Exit.isFailure(canceled)).toBe(true);
        expect(
          progress.some(({ workloadId, state }) => workloadId === "rest:rest" && state === "ready"),
        ).toBe(false);
        const retryProgress: Array<ArtifactPreparationStatus> = [];
        const cached = yield* stack.prepare({
          capabilities: ["database"],
          onProgress: (status) => retryProgress.push(status),
        });
        expect(cached.capabilities).toEqual([
          { capability: "database", version: defaultDatabaseVersion, outcome: "cached" },
        ]);
        expect(retryProgress.some(({ state }) => state === "downloading")).toBe(false);
        expect(yield* fs.readFileString(paths.stateDocument)).toBe(before);
        expect(yield* readOwnerMetadata(env.stateRoot, stack.id, env)).toBeUndefined();
        expect(yield* ownerLockExists(env.stateRoot, stack.id)).toBe(false);
        expect(yield* stateStore.read(stack.id)).toBeDefined();
      }),
    ),
  );

  it.live("prepares while running without consulting Supervisor ownership", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const env = yield* StackRuntimeEnvironment;
        const stack = yield* createStack({ projectRoot: project });
        const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
        const state = yield* store.read(stack.id);
        if (state === undefined) return yield* Effect.die("stack state was not initialized");
        yield* store.replace(stack.id, { ...state, desiredLifecycle: "running" });
        expect((yield* stack.prepare({ capabilities: [] })).capabilities).toEqual([]);
        expect((yield* store.read(stack.id))?.desiredLifecycle).toBe("running");
        expect(yield* readOwnerMetadata(env.stateRoot, stack.id, env)).toBeUndefined();
      }),
    ),
  );

  it.live("omits undefined optional RPC payload keys", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-effect-stack-rpc-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "session";
        const payloads: { start: Array<unknown> } = { start: [] };
        const rpcHandlers: StackRpcHandlers = {
          status: () => Effect.succeed(runningStatus),
          credentials: () => Effect.succeed(credentials),
          start: (payload) => {
            payloads.start.push(payload);
            return Effect.succeed(runningStatus);
          },
          destroy: () => Effect.void,
          logs: emptyLogs,
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcHandlers,
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            } as const),
            stop: Effect.succeed({ ok: true, op: "stop" } as const),
          },
        });
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_001,
          rpcRelease: STACK_RPC_RELEASE,
        };
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: () => Effect.succeed(Option.some({ owner, launched: false })),
        });
        yield* stack.start();
        yield* stack.start({ config: {} });
        expect(payloads.start).toEqual([{}, { config: {} }]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("launches a compatible Supervisor when start finds no live owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-effect-stack-start-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "start-session";
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_001,
          rpcRelease: STACK_RPC_RELEASE,
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcHandlers: {
            status: () => Effect.succeed(runningStatus),
            credentials: () => Effect.succeed(credentials),
            start: () => Effect.succeed(runningStatus),
            destroy: () => Effect.void,
            logs: emptyLogs,
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Effect.succeed({ ok: true, op: "stop" }),
          },
        });
        let launched = false;
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: (launch) =>
            Effect.sync(() => {
              launched ||= launch;
              return launched ? Option.some({ owner, launched: true }) : Option.none();
            }),
        });
        expect((yield* stack.start()).lifecycle).toBe("running");
        expect(launched).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("completes destroy after the owner closes its control socket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-effect-stack-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "session";
        const responseSent = yield* Deferred.make<void>();
        const ownerScope = yield* Scope.make();
        const rpcHandlers: StackRpcHandlers = {
          status: () => Effect.succeed(runningStatus),
          credentials: () => Effect.succeed(credentials),
          start: () => Effect.succeed(runningStatus),
          destroy: () => Effect.void,
          logs: emptyLogs,
        };
        const maintenanceHandlers = {
          probe: Effect.succeed({
            ok: true,
            op: "probe",
            stackId,
            ownerSessionId,
            rpcRelease: STACK_RPC_RELEASE,
          } as const),
          stop: Effect.succeed({ ok: true, op: "stop" } as const),
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcHandlers,
          maintenanceHandlers,
          onShutdownReady: Deferred.succeed(responseSent, undefined).pipe(Effect.asVoid),
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: () =>
            Effect.succeed(
              Option.some({
                owner: {
                  format: "supabase-stack-owner-v1" as const,
                  stackId,
                  endpoint,
                  ownerSessionId,
                  leasePort: 45_001,
                  rpcRelease: STACK_RPC_RELEASE,
                },
                launched: false,
              }),
            ),
          readPersistedState: Effect.succeed(Option.some(stoppedState())),
        });
        const destroyFiber = yield* Effect.forkChild(stack.destroy(), { startImmediately: true });
        yield* Deferred.await(responseSent);
        yield* Scope.close(ownerScope, Exit.void);
        const destroyed = yield* Fiber.join(destroyFiber).pipe(Effect.exit);
        expect(Exit.isSuccess(destroyed)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("fails destroy when the owner control endpoint is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-effect-stack-" });
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: () =>
            Effect.succeed(
              Option.some({
                owner: {
                  format: "supabase-stack-owner-v1" as const,
                  stackId,
                  endpoint: { kind: "unix", path: path.join(root, "missing.sock") },
                  ownerSessionId: "session",
                  leasePort: 45_001,
                  rpcRelease: STACK_RPC_RELEASE,
                },
                launched: false,
              }),
            ),
          readPersistedState: Effect.succeed(Option.some(stoppedState())),
        });
        const result = yield* stack.destroy().pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Cause.findErrorOption(result.cause);
          expect(Option.isSome(error)).toBe(true);
          if (Option.isSome(error)) {
            expect(error.value).toBeInstanceOf(StackDestructionError);
            expect(error.value.message).toContain("control connection");
          }
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("fails destroy without launching an owner when persisted state is absent", () =>
    Effect.gen(function* () {
      let launchCalls = 0;
      const stack = yield* makeTestHandle(stackId, {
        resolveOwner: (launch) =>
          Effect.sync(() => {
            if (launch) launchCalls += 1;
            return Option.none();
          }),
        readPersistedState: Effect.succeed(Option.none()),
      });
      const result = yield* stack.destroy().pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const failure = Cause.findErrorOption(result.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) expect(failure.value).toBeInstanceOf(StackNotFoundError);
      }
      expect(launchCalls).toBe(0);
    }),
  );

  it.live(
    "stops an incompatible owner before starting a replacement",
    () =>
      withRuntimeRoot((project) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const env = yield* StackRuntimeEnvironment;
          const stack = yield* createStack({ projectRoot: project, runtime: { kind: "native" } });
          yield* Effect.addFinalizer(() => stack.destroy().pipe(Effect.ignore));
          const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
          yield* ensureSupervisor({
            stackId: stack.id,
            stateStore: store,
            environment: env,
          });
          const owner = yield* readOwnerMetadata(env.stateRoot, stack.id, env);
          expect(owner).toBeDefined();
          if (owner === undefined) return;
          const paths = yield* resolveStackPaths({ stateRoot: env.stateRoot, stackId: stack.id });
          const incompatibleOwner = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown),
          )({
            ...owner,
            rpcRelease: "stack-rpc-v0@0.0.1",
          }).pipe(
            Effect.mapError(
              (cause) =>
                new StackDestructionError({ message: "Unable to encode test owner", cause }),
            ),
          );
          yield* fs.writeFileString(paths.controlMetadata, incompatibleOwner);

          const oldOwner = yield* openStack(stack.id);
          expect(Exit.isFailure(yield* oldOwner.status().pipe(Effect.exit))).toBe(true);
          const ordinaryCreate = yield* createStack({ projectRoot: project });
          expect(ordinaryCreate.id).toBe(stack.id);
          const restarted = yield* openStack(stack.id);
          yield* Effect.addFinalizer(() => restarted.destroy().pipe(Effect.ignore));
          const directStart = yield* restarted
            .start({ config: { capabilities: {} } })
            .pipe(Effect.exit);
          expect(Exit.isFailure(directStart)).toBe(true);
          if (Exit.isFailure(directStart)) {
            const failure = Cause.findErrorOption(directStart.cause);
            expect(Option.isSome(failure)).toBe(true);
            if (Option.isSome(failure))
              expect(failure.value).toBeInstanceOf(StackUpgradeRequiredError);
          }
          yield* restarted.stop();
          const status = yield* restarted.start({ config: { capabilities: {} } });
          const currentOwner = yield* readOwnerMetadata(env.stateRoot, stack.id, env);
          expect(currentOwner?.rpcRelease).toBe(STACK_RPC_RELEASE);
          expect(currentOwner?.ownerSessionId).not.toBe(owner.ownerSessionId);
          expect(status.id).toBe(stack.id);
          expect(status.runtime).toEqual({ kind: "native" });
          expect((yield* restarted.status()).lifecycle).toBe("running");
          yield* restarted.stop();
          expect(yield* readOwnerMetadata(env.stateRoot, stack.id, env)).toBeUndefined();
          expect(yield* ownerLockExists(env.stateRoot, stack.id)).toBe(false);
          const startedAgain = yield* restarted.start({ config: { capabilities: {} } });
          expect(startedAgain.lifecycle).toBe("running");
          yield* restarted.destroy();
        }),
      ),
    240_000,
  );

  it.live(
    "reclaims a dead incompatible owner through create and start",
    () =>
      withRuntimeRoot((project) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const env = yield* StackRuntimeEnvironment;
          const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
          const makeDeadOwner = (
            projectRoot: string,
            rpcRelease: string,
            desiredLifecycle: "running" | "unconfigured" = "unconfigured",
          ) =>
            Effect.gen(function* () {
              const identity = yield* resolveStackIdentity({ projectRoot });
              const id = yield* deriveStackId(identity);
              const persisted =
                desiredLifecycle === "running"
                  ? yield* Effect.gen(function* () {
                      const compiled = yield* compileStack({
                        projectRoot,
                        runtime: { kind: "native" },
                        config: { capabilities: {} },
                      });
                      const resolved = yield* resolveSecrets(
                        {
                          declarations: compiled.secrets.map(
                            ({ slot, policy, value, generator }) => ({
                              slot,
                              policy,
                              ...(value === undefined ? {} : { value }),
                              ...(generator === undefined ? {} : { generator }),
                            }),
                          ),
                        },
                        undefined,
                        "running",
                      );
                      return {
                        definition: compiled.definition,
                        secrets: resolved.persisted,
                      };
                    })
                  : undefined;
              const initialState: PersistedStackState = {
                format: "supabase-stack-state-v1",
                identity: toPersistedIdentity(identity, id),
                runtime: { kind: "native" },
                desiredLifecycle,
                ports: [],
                privatePorts: [],
                secrets: {},
              };
              yield* store.initialize(
                id,
                persisted === undefined ? initialState : { ...initialState, ...persisted },
              );
              const encodedEnvironment = yield* Schema.encodeEffect(
                Schema.fromJsonString(Schema.Unknown),
              )({
                stateRoot: env.stateRoot,
                tempRoot: env.tempRoot,
                platform: env.platform,
              });
              const child = yield* ChildProcess.make(
                process.execPath,
                [
                  "--input-type=module",
                  "-e",
                  `
                  const { Effect } = await import("effect");
                  const { NodeServices } = await import("@effect/platform-node");
                  const { acquireOwnership, publishOwnership } = await import(process.env.OWNERSHIP_MODULE);
                  const environment = JSON.parse(process.env.OWNERSHIP_ENVIRONMENT);
                  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
                    const lease = yield* acquireOwnership({
                      stateRoot: environment.stateRoot,
                      stackId: process.env.OWNERSHIP_STACK_ID,
                      ownerSessionId: "crashed-owner",
                      rpcRelease: process.env.OWNERSHIP_RPC_RELEASE,
                      environment,
                    });
                    yield* publishOwnership(lease);
                    process.stdout.write("READY\\n");
                    yield* Effect.never;
                  }).pipe(Effect.provide(NodeServices.layer))));
                `,
                ],
                {
                  cwd: process.cwd(),
                  env: {
                    OWNERSHIP_MODULE: new URL("../state/Ownership.ts", import.meta.url).href,
                    OWNERSHIP_STACK_ID: id,
                    OWNERSHIP_RPC_RELEASE: rpcRelease,
                    OWNERSHIP_ENVIRONMENT: encodedEnvironment,
                  },
                  extendEnv: true,
                  stdout: "pipe",
                  stderr: "pipe",
                },
              );
              const ready = yield* Deferred.make<void>();
              const output = yield* child.stdout.pipe(
                Stream.decodeText,
                Stream.splitLines,
                Stream.runForEach((line) =>
                  line === "READY"
                    ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                ),
                Effect.forkChild({ startImmediately: true }),
              );
              const stderr = yield* child.stderr.pipe(
                Stream.decodeText,
                Stream.splitLines,
                Stream.runDrain,
                Effect.forkChild({ startImmediately: true }),
              );
              try {
                yield* Deferred.await(ready).pipe(
                  Effect.timeoutOrElse({
                    duration: "5 seconds",
                    orElse: () =>
                      Effect.fail(new StackStateInvalidError({ message: "owner child not ready" })),
                  }),
                );
                expect(yield* ownerLockExists(env.stateRoot, id)).toBe(true);
                yield* child.kill({ killSignal: "SIGKILL" });
                yield* child.exitCode.pipe(Effect.ignore);
                return id;
              } finally {
                yield* child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
                yield* Fiber.interrupt(output);
                yield* Fiber.interrupt(stderr);
              }
            });

          const createProject = path.join(project, "create");
          const openProject = path.join(project, "open");
          yield* fs.makeDirectory(createProject);
          yield* fs.makeDirectory(openProject);
          const created = yield* createStack({ projectRoot: createProject });
          expect(yield* readOwnerMetadata(env.stateRoot, created.id, env)).toBeUndefined();
          expect(yield* ownerLockExists(env.stateRoot, created.id)).toBe(false);

          const openId = yield* makeDeadOwner(openProject, "stack-rpc-v0@0.0.1", "running");
          const replaced = yield* openStack(openId);
          const cleanupRecovered = yield* Effect.cached(
            Effect.uninterruptible(
              Effect.gen(function* () {
                yield* replaced.stop();
                yield* replaced.destroy();
                expect(yield* readOwnerMetadata(env.stateRoot, openId, env)).toBeUndefined();
                expect(yield* ownerLockExists(env.stateRoot, openId)).toBe(false);
              }),
            ),
          );
          // Register exact cleanup before launching the replacement. The cached effect makes the
          // explicit assertion below and scope finalization share one stop/destroy transition.
          yield* Effect.addFinalizer(() => cleanupRecovered.pipe(Effect.ignore));
          yield* replaced.start();
          expect((yield* readOwnerMetadata(env.stateRoot, openId, env))?.rpcRelease).toBe(
            STACK_RPC_RELEASE,
          );
          expect((yield* readOwnerMetadata(env.stateRoot, openId, env))?.ownerSessionId).not.toBe(
            "crashed-owner",
          );
          expect(yield* ownerLockExists(env.stateRoot, openId)).toBe(true);
          yield* cleanupRecovered;
        }),
      ),
    300_000,
  );

  it.live("accepts maintenance stop requests from an older RPC owner", () =>
    withRuntimeRoot((project) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const env = yield* StackRuntimeEnvironment;
        const stack = yield* createStack({ projectRoot: project, runtime: { kind: "native" } });
        const store = yield* makeStackStateStore({ stateRoot: env.stateRoot });
        yield* ensureSupervisor({
          stackId: stack.id,
          stateStore: store,
          environment: env,
        });
        const ownerHandle = yield* openStack(stack.id);
        yield* Effect.addFinalizer(() => ownerHandle.stop().pipe(Effect.ignore));
        const owner = yield* readOwnerMetadata(env.stateRoot, stack.id, env);
        expect(owner).toBeDefined();
        if (owner === undefined) return;
        const paths = yield* resolveStackPaths({ stateRoot: env.stateRoot, stackId: stack.id });
        const incompatibleOwner = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          {
            ...owner,
            rpcRelease: "stack-rpc-v0@0.0.1",
          },
        ).pipe(
          Effect.mapError(
            (cause) => new StackDestructionError({ message: "Unable to encode test owner", cause }),
          ),
        );
        yield* fs.writeFileString(paths.controlMetadata, incompatibleOwner);
        yield* ownerHandle.stop();
        expect(yield* readOwnerMetadata(env.stateRoot, stack.id, env)).toBeUndefined();
        expect(yield* ownerLockExists(env.stateRoot, stack.id)).toBe(false);
      }),
    ),
  );

  it.live(
    "rejects incompatible RPC calls before opening handlers while allowing maintenance stop",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: "supabase-effect-stack-release-",
          });
          const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
          const ownerSessionId = "incompatible-rpc-session";
          const ownerRelease = "stack-rpc-v0@0.0.1";
          const ownerScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
          const calls = yield* Ref.make(0);
          const invoked = <A>(value: A) =>
            Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(Effect.succeed(value)));
          const owner = {
            format: "supabase-stack-owner-v1" as const,
            stackId,
            endpoint,
            ownerSessionId,
            leasePort: 45_001,
            rpcRelease: ownerRelease,
          };
          yield* startControlServer({
            endpoint,
            stackId,
            ownerSessionId,
            rpcRelease: ownerRelease,
            rpcHandlers: {
              status: () => invoked(runningStatus),
              credentials: () => invoked(credentials),
              start: () => invoked(runningStatus),
              destroy: () => invoked(undefined),
              logs: () => invoked({ entries: [], cursor: { opaque: "v1_0" }, running: false }),
            },
            maintenanceHandlers: {
              probe: Effect.succeed({
                ok: true,
                op: "probe",
                stackId,
                ownerSessionId,
                rpcRelease: ownerRelease,
              }),
              stop: Effect.succeed({ ok: true, op: "stop" }),
            },
            onShutdownReady: Scope.close(ownerScope, Exit.void),
          }).pipe(Effect.provideService(Scope.Scope, ownerScope));
          const stack = yield* makeTestHandle(stackId, {
            resolveOwner: () => Effect.succeed(Option.some({ owner, launched: false })),
          });
          const status = yield* stack.status().pipe(Effect.exit);
          const stackCredentials = yield* stack.credentials().pipe(Effect.exit);
          const logs = yield* stack.logs().pipe(Effect.exit);
          const assertUpgrade = (result: Exit.Exit<unknown, StackError>) => {
            expect(Exit.isFailure(result)).toBe(true);
            if (Exit.isFailure(result)) {
              const failure = Cause.findErrorOption(result.cause);
              expect(Option.isSome(failure)).toBe(true);
              if (Option.isSome(failure)) {
                expect(failure.value).toBeInstanceOf(StackUpgradeRequiredError);
                expect(failure.value).toMatchObject({
                  expectedRelease: STACK_RPC_RELEASE,
                  actualRelease: ownerRelease,
                });
              }
            }
          };
          assertUpgrade(status);
          assertUpgrade(stackCredentials);
          assertUpgrade(logs);
          expect(yield* Ref.get(calls)).toBe(0);
          yield* stack.stop();
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );

  it.live("stops a freshly launched owner when the first start RPC is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-effect-stack-launch-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "fresh-launch-session";
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        const startEntered = yield* Deferred.make<void>();
        const stopCalls = yield* Ref.make(0);
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_001,
          rpcRelease: STACK_RPC_RELEASE,
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          rpcHandlers: {
            status: () => Effect.succeed(runningStatus),
            credentials: () => Effect.succeed(credentials),
            start: () =>
              Deferred.succeed(startEntered, undefined).pipe(Effect.andThen(Effect.never)),
            destroy: () => Effect.void,
            logs: () => emptyLogs(),
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Ref.update(stopCalls, (calls) => calls + 1).pipe(
              Effect.andThen(Effect.succeed({ ok: true, op: "stop" } as const)),
            ),
          },
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: () => Effect.succeed(Option.some({ owner, launched: true })),
        });
        const start = yield* Effect.forkChild(stack.start(), { startImmediately: true });
        yield* Deferred.await(startEntered);
        yield* Fiber.interrupt(start);
        expect(yield* Ref.get(stopCalls)).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("stops a freshly launched owner when destroy is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-effect-stack-destroy-",
        });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "fresh-destroy-session";
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        const destroyEntered = yield* Deferred.make<void>();
        const stopCalls = yield* Ref.make(0);
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_001,
          rpcRelease: STACK_RPC_RELEASE,
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          rpcHandlers: {
            status: () => Effect.succeed(runningStatus),
            credentials: () => Effect.succeed(credentials),
            start: () => Effect.succeed(runningStatus),
            destroy: () =>
              Deferred.succeed(destroyEntered, undefined).pipe(Effect.andThen(Effect.never)),
            logs: () => emptyLogs(),
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Ref.update(stopCalls, (calls) => calls + 1).pipe(
              Effect.andThen(Effect.succeed({ ok: true, op: "stop" } as const)),
            ),
          },
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: () => Effect.succeed(Option.some({ owner, launched: true })),
          readPersistedState: Effect.succeed(Option.some(stoppedState())),
        });
        const destroy = yield* Effect.forkChild(stack.destroy(), { startImmediately: true });
        yield* Deferred.await(destroyEntered);
        yield* Fiber.interrupt(destroy);
        const interrupted = yield* Fiber.join(destroy).pipe(Effect.exit);
        expect(Exit.isFailure(interrupted)).toBe(true);
        expect(yield* Ref.get(stopCalls)).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("reports fresh-owner rollback failures after an interrupted start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-effect-stack-rollback-",
        });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "rollback-failure-session";
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        const startEntered = yield* Deferred.make<void>();
        const stopCalls = yield* Ref.make(0);
        const releaseCalls = yield* Ref.make(0);
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_001,
          rpcRelease: STACK_RPC_RELEASE,
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          rpcHandlers: {
            status: () => Effect.succeed(runningStatus),
            credentials: () => Effect.succeed(credentials),
            start: () =>
              Deferred.succeed(startEntered, undefined).pipe(Effect.andThen(Effect.never)),
            destroy: () => Effect.void,
            logs: () => emptyLogs(),
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Ref.update(stopCalls, (calls) => calls + 1).pipe(
              Effect.andThen(
                Effect.succeed({
                  ok: false,
                  error: { tag: "operation-failed", message: "injected rollback failure" },
                } as const),
              ),
            ),
          },
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: () => Effect.succeed(Option.some({ owner, launched: true })),
          waitForRelease: Ref.update(releaseCalls, (calls) => calls + 1).pipe(
            Effect.andThen(
              Effect.fail(new StackOwnershipConflictError({ message: "release failed" })),
            ),
          ),
        });
        const start = yield* Effect.forkChild(stack.start(), { startImmediately: true });
        yield* Deferred.await(startEntered);
        yield* Fiber.interrupt(start);
        const interrupted = yield* Fiber.join(start).pipe(Effect.exit);
        expect(Exit.isFailure(interrupted)).toBe(true);
        if (Exit.isFailure(interrupted)) {
          const failure = Cause.findErrorOption(interrupted.cause);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) {
            expect(failure.value).toBeInstanceOf(StackCleanupError);
            expect(failure.value.message).toContain(
              "Unable to clean up freshly launched Supervisor",
            );
            expect(failure.value.cause).toBeDefined();
          }
        }
        expect(yield* Ref.get(stopCalls)).toBe(1);
        expect(yield* Ref.get(releaseCalls)).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("preserves an interrupted start when fresh-owner cleanup is refused", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "ss-ar-",
        });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "admitted-rollback-session";
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        const startEntered = yield* Deferred.make<void>();
        const stopCalls = yield* Ref.make(0);
        const releaseCalls = yield* Ref.make(0);
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_001,
          rpcRelease: STACK_RPC_RELEASE,
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          rpcHandlers: {
            status: () => Effect.succeed(runningStatus),
            credentials: () => Effect.succeed(credentials),
            start: () =>
              Deferred.succeed(startEntered, undefined).pipe(Effect.andThen(Effect.never)),
            destroy: () => Effect.void,
            logs: () => emptyLogs(),
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Ref.update(stopCalls, (calls) => calls + 1).pipe(
              Effect.andThen(
                Effect.succeed({
                  ok: false,
                  error: {
                    tag: "operation-failed",
                    message: "a lifecycle transition is already in progress",
                    stackErrorTag: "StackLifecycleConflictError",
                  },
                } as const),
              ),
            ),
          },
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: () => Effect.succeed(Option.some({ owner, launched: true })),
          waitForRelease: Ref.update(releaseCalls, (calls) => calls + 1).pipe(
            Effect.andThen(
              Effect.fail(new StackOwnershipConflictError({ message: "release was unexpected" })),
            ),
          ),
        });
        const start = yield* Effect.forkChild(stack.start(), { startImmediately: true });
        yield* Deferred.await(startEntered);
        yield* Fiber.interrupt(start);
        const interrupted = yield* Fiber.join(start).pipe(Effect.exit);
        expect(Exit.isFailure(interrupted)).toBe(true);
        if (Exit.isFailure(interrupted)) {
          const failure = Cause.findErrorOption(interrupted.cause);
          expect(Option.isNone(failure)).toBe(true);
          expect(Cause.hasInterrupts(interrupted.cause)).toBe(true);
        }
        expect(yield* Ref.get(stopCalls)).toBe(1);
        expect(yield* Ref.get(releaseCalls)).toBe(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("does not stop an owner joined through a concurrent launch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-effect-stack-join-" });
        const endpoint = { kind: "unix" as const, path: path.join(root, "control.sock") };
        const ownerSessionId = "joined-launch-session";
        const ownerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
        const startEntered = yield* Deferred.make<void>();
        const stopCalls = yield* Ref.make(0);
        const owner = {
          format: "supabase-stack-owner-v1" as const,
          stackId,
          endpoint,
          ownerSessionId,
          leasePort: 45_001,
          rpcRelease: STACK_RPC_RELEASE,
        };
        yield* startControlServer({
          endpoint,
          stackId,
          ownerSessionId,
          rpcRelease: STACK_RPC_RELEASE,
          rpcHandlers: {
            status: () => Effect.succeed(runningStatus),
            credentials: () => Effect.succeed(credentials),
            start: () =>
              Deferred.succeed(startEntered, undefined).pipe(Effect.andThen(Effect.never)),
            destroy: () => Effect.void,
            logs: () => emptyLogs(),
          },
          maintenanceHandlers: {
            probe: Effect.succeed({
              ok: true,
              op: "probe",
              stackId,
              ownerSessionId,
              rpcRelease: STACK_RPC_RELEASE,
            }),
            stop: Ref.update(stopCalls, (calls) => calls + 1).pipe(
              Effect.andThen(Effect.succeed({ ok: true, op: "stop" } as const)),
            ),
          },
          onShutdownReady: Scope.close(ownerScope, Exit.void),
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const stack = yield* makeTestHandle(stackId, {
          resolveOwner: () => Effect.succeed(Option.some({ owner, launched: false })),
        });
        const start = yield* Effect.forkChild(stack.start(), { startImmediately: true });
        yield* Deferred.await(startEntered);
        yield* Fiber.interrupt(start);
        expect(yield* Ref.get(stopCalls)).toBe(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
