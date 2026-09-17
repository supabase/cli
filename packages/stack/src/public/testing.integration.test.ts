import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  ConfigProvider,
  Data,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Path,
  Stream,
} from "effect";
import { homedir, tmpdir } from "node:os";

import { CAPABILITY_NAMES } from "./Capability.ts";
import { StackCleanupError, StackRuntimeError } from "./Errors.ts";
import type { EffectStack } from "./EffectStack.ts";
import { StackIdSchema } from "./StackId.ts";
import type { StackStatus } from "./Status.ts";
import { createTestStackWith, type TestStackOperations } from "./Testing.ts";
import { defaultRuntimeEnvironment } from "../supervisor/Launcher.ts";

class FixtureError extends Data.TaggedError("FixtureError")<{ readonly cause?: unknown }> {}

const stackId = StackIdSchema.make(
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
);

const status = (
  lifecycle: StackStatus["lifecycle"],
  includeApi = true,
  functionsState: "ready" | "dormant" | "stopping" | "stopped" = "dormant",
  failedCapability?: string,
): StackStatus => ({
  id: stackId,
  lifecycle,
  desiredLifecycle: lifecycle === "starting" || lifecycle === "stopping" ? "running" : lifecycle,
  runtime: { kind: "native" },
  endpoints:
    lifecycle === "running" && includeApi
      ? {
          api: {
            protocol: "http",
            address: "127.0.0.1",
            port: 54321,
            url: "http://127.0.0.1:54321",
          },
        }
      : {},
  versions: {},
  capabilities: CAPABILITY_NAMES.map((name) => ({
    name,
    activation: name === "functions" ? "lazy" : "eager",
    state:
      lifecycle === "running"
        ? name === "pooler"
          ? "disabled"
          : name === "functions"
            ? functionsState
            : "ready"
        : "stopped",
    ...(failedCapability === name ? { state: "failed", error: `${name} failed` } : {}),
  })),
  artifacts: [],
  instances: [],
});

type FakeStackOptions = {
  readonly failStart?: boolean;
  readonly reachesReadiness?: boolean;
  readonly includeApi?: boolean;
  readonly functionsState?: "ready" | "dormant" | "stopping" | "stopped";
  readonly failedCapability?: string;
  readonly failDestroy?: boolean;
};

const fakeStack = (events: Array<string>, options: FakeStackOptions = {}): EffectStack => {
  const {
    failStart = false,
    reachesReadiness = true,
    includeApi = true,
    functionsState = "dormant",
    failedCapability,
    failDestroy = false,
  } = options;
  const currentStatus = () =>
    status(reachesReadiness ? "running" : "stopped", includeApi, functionsState, failedCapability);
  return {
    id: stackId,
    services: {
      create: () => Effect.die("service fixture is not configured"),
      get: () => Effect.die("service fixture is not configured"),
      list: Effect.succeed([]),
    },
    status: Effect.sync(currentStatus),
    credentials: Effect.die("credentials fixture is not configured"),
    prepare: () => Effect.succeed({ instances: [] }),
    start: () =>
      failStart
        ? Effect.sync(() => {
            events.push("start");
            return Effect.fail(new StackRuntimeError({ message: "startup failed" }));
          }).pipe(Effect.flatten)
        : Effect.sync(() => {
            events.push("start");
            return currentStatus();
          }),
    sleep: () => Effect.sync(currentStatus),
    stop: () => Effect.sync(() => status("stopped", includeApi, functionsState, failedCapability)),
    restart: () => Effect.sync(currentStatus),
    destroy: () =>
      Effect.sync(() => {
        events.push("destroy");
        return failDestroy
          ? Effect.fail(new StackCleanupError({ message: "destroy failed" }))
          : Effect.void;
      }).pipe(Effect.flatten),
    logs: () => Effect.succeed({ entries: [], cursor: { opaque: "v1_0" }, running: false }),
    followLogs: (_query) => Stream.empty,
    followStatus: Stream.empty,
  };
};

const setupFixture = (root: string, stackOptions: FakeStackOptions = {}) => {
  const events: Array<string> = [];
  const removed: Array<string> = [];
  const operations: TestStackOperations = {
    createRoot: Effect.succeed(root),
    createStack: (options) =>
      Effect.sync(() => {
        events.push(`create:${options.projectRoot}`);
        return fakeStack(events, stackOptions);
      }),
    removeRoot: (removedRoot) => Effect.sync(() => void removed.push(removedRoot)),
  };
  return { events, removed, operations };
};

const getFailure = <A, E>(exit: Exit.Exit<A, E>): unknown =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe("test stack resource", () => {
  it.live("starts automatically and destroys only its owned identity", () =>
    Effect.gen(function* () {
      const { events, removed, operations } = setupFixture("/tmp/stack-test-owned");
      yield* Effect.scoped(
        Effect.acquireUseRelease(
          createTestStackWith({}, operations),
          () => Effect.void,
          (stack) => stack.destroy(),
        ),
      );
      expect(events).toEqual(["create:/tmp/stack-test-owned", "start", "destroy"]);
      expect(removed).toEqual(["/tmp/stack-test-owned"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("preserves startup failure while retaining the root when destroy fails", () =>
    Effect.gen(function* () {
      const { events, removed, operations } = setupFixture("/tmp/stack-test-failed", {
        failStart: true,
        failDestroy: true,
      });
      const result = yield* Effect.exit(createTestStackWith({}, operations));
      const failure = getFailure(result);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        message: expect.stringContaining("retained test stack root"),
      });
      expect(events).toEqual(["create:/tmp/stack-test-failed", "start", "destroy"]);
      expect(removed).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("includes bounded startup diagnostics before cleanup removes a failed stack", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const removed: Array<string> = [];
      const entries = Array.from({ length: 51 }, (_, index) => ({
        cursor: { opaque: `v1_${(index + 1).toString(36)}` },
        timestamp: "2026-01-01T00:00:00.000Z",
        source: "pooler" as const,
        stream: "stderr" as const,
        message: index === 50 ? "pooler stderr" : `old-${index}`,
      }));
      const operations: TestStackOperations = {
        createRoot: Effect.succeed("/tmp/stack-test-diagnostics"),
        createStack: () =>
          Effect.succeed({
            ...fakeStack(events),
            start: () =>
              Effect.sync(() => {
                events.push("start");
                return Effect.fail(new StackRuntimeError({ message: "startup failed" }));
              }).pipe(Effect.flatten),
            status: Effect.succeed(status("starting")),
            logs: () => Effect.succeed({ entries, cursor: { opaque: "v1_1" }, running: false }),
          }),
        removeRoot: (root) => Effect.sync(() => void removed.push(root)),
      };
      const result = yield* Effect.exit(createTestStackWith({}, operations));
      const failure = getFailure(result);
      expect(failure).toMatchObject({ message: expect.stringContaining("pooler stderr") });
      expect(failure).toMatchObject({ message: expect.not.stringContaining("old-0") });
      expect(events).toEqual(["start", "destroy"]);
      expect(removed).toEqual(["/tmp/stack-test-diagnostics"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("runs setupProject after creating the root and before creating the stack", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const operations: TestStackOperations = {
        createRoot: Effect.succeed("/tmp/stack-test-setup"),
        createStack: (options) =>
          Effect.sync(() => {
            events.push(`create:${options.projectRoot}`);
            return fakeStack(events);
          }),
        removeRoot: () => Effect.sync(() => void events.push("remove")),
      };
      const stack = yield* createTestStackWith(
        { setupProject: (root) => Effect.sync(() => void events.push(`setup:${root}`)) },
        operations,
      );
      yield* stack.destroy();
      expect(events).toEqual([
        "setup:/tmp/stack-test-setup",
        "create:/tmp/stack-test-setup",
        "start",
        "destroy",
        "remove",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("uses the managed runtime state root without mutating process environment", () =>
    Effect.gen(function* () {
      const originalEnvironment = yield* defaultRuntimeEnvironment;
      let environment: Parameters<NonNullable<TestStackOperations["createStack"]>>[1];
      const operations: TestStackOperations = {
        createRoot: Effect.succeed("/tmp/stack-test-isolated-state"),
        createStack: (_options, runtimeEnvironment) =>
          Effect.sync(() => {
            environment = runtimeEnvironment;
            return fakeStack([]);
          }),
        removeRoot: () => Effect.void,
      };
      const stack = yield* createTestStackWith({}, operations);
      yield* stack.destroy();
      expect(environment?.stateRoot).toBe(originalEnvironment.stateRoot);
      expect(environment?.artifactCacheRoot).toBe(
        (yield* Path.Path).join(tmpdir(), "supabase-stack-test-artifacts"),
      );
      expect(yield* defaultRuntimeEnvironment).toEqual(originalEnvironment);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("falls back to the OS home when HOME is unavailable", () =>
    Effect.gen(function* () {
      const environment = yield* defaultRuntimeEnvironment.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
      );
      expect(environment.stateRoot).toBe(`${homedir()}/.supabase/managed/stacks`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("removes the exact root when setupProject fails", () =>
    Effect.gen(function* () {
      let created = false;
      const removed: Array<string> = [];
      const operations: TestStackOperations = {
        createRoot: Effect.succeed("/tmp/stack-test-setup-failed"),
        createStack: () =>
          Effect.sync(() => {
            created = true;
            return fakeStack([]);
          }),
        removeRoot: (root) => Effect.sync(() => void removed.push(root)),
      };
      const result = yield* Effect.exit(
        createTestStackWith(
          { setupProject: () => Effect.fail(new FixtureError({ cause: "project setup failed" })) },
          operations,
        ),
      );
      expect(getFailure(result)).toMatchObject({
        message: expect.stringContaining("project setup failed"),
      });
      expect(created).toBe(false);
      expect(removed).toEqual(["/tmp/stack-test-setup-failed"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("allows lazy Functions to stop during a running stack", () =>
    Effect.gen(function* () {
      const { events, operations } = setupFixture("/tmp/stack-test-lazy-stopping", {
        functionsState: "stopping",
      });
      const stack = yield* createTestStackWith(
        { config: { capabilities: { functions: {} } } },
        operations,
      );
      yield* stack.destroy();
      expect(events).toEqual(["create:/tmp/stack-test-lazy-stopping", "start", "destroy"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rejects a stack that stops before becoming ready", () =>
    Effect.gen(function* () {
      const { events, removed, operations } = setupFixture("/tmp/stack-test-unready", {
        reachesReadiness: false,
      });
      const result = yield* Effect.exit(
        createTestStackWith({ config: { capabilities: { database: {} } } }, operations),
      );
      expect(getFailure(result)).toMatchObject({
        message: expect.stringContaining("lifecycle stopped"),
      });
      expect(events).toEqual(["create:/tmp/stack-test-unready", "start", "destroy"]);
      expect(removed).toEqual(["/tmp/stack-test-unready"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("accepts disabled Functions without an API listener", () =>
    Effect.gen(function* () {
      const { events, removed, operations } = setupFixture("/tmp/stack-test-disabled", {
        includeApi: false,
        functionsState: "stopped",
      });
      const stack = yield* createTestStackWith(
        { config: { capabilities: { functions: { enabled: false } } } },
        operations,
      );
      yield* stack.destroy();
      expect(events).toEqual(["create:/tmp/stack-test-disabled", "start", "destroy"]);
      expect(removed).toEqual(["/tmp/stack-test-disabled"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reports a failed capability with diagnostics and removes its root", () =>
    Effect.gen(function* () {
      const { events, removed, operations } = setupFixture("/tmp/stack-test-capability-failed", {
        failedCapability: "auth",
      });
      const result = yield* Effect.exit(createTestStackWith({}, operations));
      expect(getFailure(result)).toMatchObject({ message: expect.stringContaining("auth failed") });
      expect(events).toEqual(["create:/tmp/stack-test-capability-failed", "start", "destroy"]);
      expect(removed).toEqual(["/tmp/stack-test-capability-failed"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rejects a lifecycle that starts stopping before becoming ready", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const removed: Array<string> = [];
      const operations: TestStackOperations = {
        createRoot: Effect.succeed("/tmp/stack-test-stopping"),
        createStack: () =>
          Effect.succeed({
            ...fakeStack(events),
            start: () =>
              Effect.sync(() => {
                events.push("start");
                return status("stopping");
              }),
          }),
        removeRoot: (root) => Effect.sync(() => void removed.push(root)),
      };
      const result = yield* Effect.exit(createTestStackWith({}, operations));
      expect(getFailure(result)).toMatchObject({
        message: expect.stringContaining("lifecycle stopping"),
      });
      expect(events).toEqual(["start", "destroy"]);
      expect(removed).toEqual(["/tmp/stack-test-stopping"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps the project root for selected service destruction", () =>
    Effect.gen(function* () {
      const { removed, operations } = setupFixture("/tmp/stack-test-selected-destroy");
      const stack = yield* createTestStackWith({}, operations);
      yield* stack.destroy({ services: [] });
      expect(removed).toEqual([]);
      yield* stack.destroy();
      expect(removed).toEqual(["/tmp/stack-test-selected-destroy"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("creates automatic roots below managed state and removes that exact root", () =>
    Effect.gen(function* () {
      let createdRoot: string | undefined;
      let setupRoot: string | undefined;
      const stack = yield* createTestStackWith(
        {
          setupProject: (root) => Effect.sync(() => void (setupRoot = root)),
        },
        {
          createStack: (options) =>
            Effect.sync(() => {
              createdRoot = options.projectRoot;
              return fakeStack([]);
            }),
          removeRoot: (root) =>
            Effect.flatMap(FileSystem.FileSystem, (fs) =>
              fs.remove(root, { recursive: true, force: true }),
            ).pipe(Effect.provide(NodeServices.layer)),
        },
      );
      const managedRoot = (yield* defaultRuntimeEnvironment).stateRoot;
      const path = yield* Path.Path;
      const projectsRoot = path.join(path.dirname(managedRoot), "test-projects");
      expect(setupRoot).toBe(createdRoot);
      expect(createdRoot?.startsWith(`${projectsRoot}${path.sep}`)).toBe(true);
      yield* stack.destroy();
      expect(createdRoot).toBeDefined();
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(createdRoot ?? "")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("cleans up overlapping stacks independently", () =>
    Effect.gen(function* () {
      const roots = ["/tmp/stack-test-shared-a", "/tmp/stack-test-shared-b"];
      const removed: Array<string> = [];
      const operations: TestStackOperations = {
        createRoot: Effect.suspend(() => {
          const root = roots.shift();
          return root === undefined
            ? Effect.fail(new FixtureError({ cause: "no test root" }))
            : Effect.succeed(root);
        }),
        createStack: () => Effect.succeed(fakeStack([])),
        removeRoot: (root) => Effect.sync(() => void removed.push(root)),
      };
      const stacks = yield* Effect.all(
        [createTestStackWith({}, operations), createTestStackWith({}, operations)],
        { concurrency: 2 },
      );
      yield* Effect.all(
        stacks.map((stack) => stack.destroy()),
        { concurrency: 2 },
      );
      expect(removed).toEqual(["/tmp/stack-test-shared-a", "/tmp/stack-test-shared-b"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("removes the exact root when acquisition is interrupted", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const events: Array<string> = [];
      const removed: Array<string> = [];
      const operations: TestStackOperations = {
        createRoot: Effect.succeed("/tmp/stack-test-interrupted"),
        createStack: () =>
          Effect.succeed({
            ...fakeStack(events),
            start: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                return yield* Effect.never;
              }),
          }),
        removeRoot: (root) => Effect.sync(() => void removed.push(root)),
      };
      const fiber = yield* Effect.forkChild(createTestStackWith({}, operations));
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      const result = yield* Fiber.await(fiber);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) expect(Cause.hasInterrupts(result.cause)).toBe(true);
      expect(events).toEqual(["destroy"]);
      expect(removed).toEqual(["/tmp/stack-test-interrupted"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("retains the root when an explicit destroy fails and permits retry", () =>
    Effect.gen(function* () {
      let failDestroy = true;
      const { removed, operations: baseOperations } = setupFixture("/tmp/stack-test-retained");
      const operations: TestStackOperations = {
        ...baseOperations,
        createStack: () =>
          Effect.sync(() => {
            const resource = fakeStack([], { failDestroy: false });
            return {
              ...resource,
              destroy: () =>
                failDestroy
                  ? Effect.fail(new StackCleanupError({ message: "destroy failed" }))
                  : Effect.void,
            };
          }),
      };
      const stack = yield* createTestStackWith({}, operations);
      const first = yield* Effect.exit(stack.destroy());
      expect(getFailure(first)).toMatchObject({ message: "destroy failed" });
      expect(removed).toEqual([]);
      failDestroy = false;
      yield* stack.destroy();
      expect(removed).toEqual(["/tmp/stack-test-retained"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
