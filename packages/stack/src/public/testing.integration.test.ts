import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Data, Effect, Exit, Path, Stream } from "effect";
import { homedir, tmpdir } from "node:os";

import type { PromiseStack } from "./PromiseStack.ts";
import { createTestStackWith, type TestStackOperations } from "./Testing.ts";
import { defaultRuntimeEnvironment } from "../supervisor/Launcher.ts";
import { CAPABILITY_NAMES } from "./Capability.ts";
import { StackIdSchema } from "./StackId.ts";
import type { StackStatus } from "./Status.ts";
class FixtureError extends Data.TaggedError("FixtureError")<{ readonly cause: unknown }> {}
const fixturePromise = <A>(thunk: () => A): Promise<A> =>
  Effect.runPromiseExit(
    Effect.try({ try: thunk, catch: (cause) => new FixtureError({ cause }) }),
  ).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const error = Cause.squash(exit.cause);
    throw error instanceof FixtureError ? error.cause : error;
  });

const stackId = StackIdSchema.make(
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
);
const status = (
  lifecycle: StackStatus["lifecycle"],
  includeApi = true,
  functionsState: "ready" | "dormant" | "stopped" = "dormant",
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
});
const stream = <A>(values: ReadonlyArray<A>): AsyncIterable<A> =>
  Stream.toAsyncIterable(Stream.fromIterable(values));
type FakeStackOptions = {
  readonly failStart?: boolean;
  readonly reachesReadiness?: boolean;
  readonly includeApi?: boolean;
  readonly functionsState?: "ready" | "dormant" | "stopped";
  readonly failedCapability?: string;
};
const fakeStack = (events: Array<string>, options: FakeStackOptions = {}): PromiseStack => {
  const {
    failStart = false,
    reachesReadiness = true,
    includeApi = true,
    functionsState = "dormant",
    failedCapability,
  } = options;
  return {
    id: stackId,
    status: () =>
      fixturePromise(() =>
        status(
          reachesReadiness ? "running" : "stopped",
          includeApi,
          functionsState,
          failedCapability,
        ),
      ),
    credentials: () =>
      fixturePromise(() => ({
        database: { url: "postgres://test", password: "test" },
        api: {
          publishableKey: "publishable",
          secretKey: "secret",
          anonJwt: "anon",
          serviceRoleJwt: "service",
        },
        storage: {
          endpoint: "http://storage",
          region: "local",
          accessKeyId: "access",
          secretAccessKey: "storage",
        },
      })),
    prepare: () => fixturePromise(() => ({ capabilities: [] })),
    start: () =>
      fixturePromise(() => {
        events.push("start");
        if (failStart) throw new Error("startup failed");
        return status(
          reachesReadiness ? "running" : "stopped",
          includeApi,
          functionsState,
          failedCapability,
        );
      }),
    stop: () => fixturePromise(() => undefined),
    destroy: () =>
      fixturePromise(() => {
        events.push("destroy");
        if (failStart) throw new Error("destroy failed");
      }),
    resetDatabase: () =>
      fixturePromise(() =>
        status(
          reachesReadiness ? "running" : "stopped",
          includeApi,
          functionsState,
          failedCapability,
        ),
      ),
    logs: () => fixturePromise(() => ({ entries: [], cursor: { opaque: "v1_0" }, running: false })),
    followLogs: () => stream([]),
  };
};
const setupFixture = (root: string, stackOptions: FakeStackOptions = {}) => {
  const events: Array<string> = [];
  const removed: Array<string> = [];
  const operations: TestStackOperations = {
    createRoot: () => fixturePromise(() => root),
    createStack: (options) =>
      fixturePromise(() => {
        events.push(`create:${options.projectRoot}`);
        return fakeStack(events, stackOptions);
      }),
    removeRoot: (removedRoot) =>
      fixturePromise(() => {
        removed.push(removedRoot);
      }),
  };
  return { events, removed, operations };
};
describe("test stack resource", () => {
  it.live("starts automatically and destroys only its owned identity", () =>
    Effect.gen(function* () {
      const { events, removed, operations } = setupFixture("/tmp/stack-test-owned");
      const stack = yield* Effect.promise(() => createTestStackWith({}, operations));
      yield* Effect.promise(() => stack[Symbol.asyncDispose]());
      expect(events).toEqual(["create:/tmp/stack-test-owned", "start", "destroy"]);
      expect(removed).toEqual(["/tmp/stack-test-owned"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("preserves startup failure while retaining the root when destroy fails", () =>
    Effect.gen(function* () {
      const { events, removed, operations } = setupFixture("/tmp/stack-test-failed", {
        failStart: true,
      });
      yield* Effect.promise(() =>
        expect(createTestStackWith({}, operations)).rejects.toThrow(
          /startup failed[\s\S]*retained test stack root \/tmp\/stack-test-failed/,
        ),
      );
      expect(events).toEqual(["create:/tmp/stack-test-failed", "start", "destroy"]);
      expect(removed).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("includes bounded startup diagnostics before cleanup removes a failed stack", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const removed: Array<string> = [];
      const logQueries: Array<Parameters<PromiseStack["logs"]>[0]> = [];
      const entries = Array.from({ length: 51 }, (_, index) => ({
        cursor: { opaque: `v1_${(index + 1).toString(36)}` },
        timestamp: "2026-01-01T00:00:00.000Z",
        source: "pooler" as const,
        stream: "stderr" as const,
        message: index === 50 ? "pooler stderr" : `old-${index}`,
      }));
      const operations: TestStackOperations = {
        createRoot: () => fixturePromise(() => "/tmp/stack-test-diagnostics"),
        createStack: () =>
          fixturePromise(() => ({
            ...fakeStack(events),
            start: () =>
              fixturePromise(() => {
                events.push("start");
                throw new Error("startup failed");
              }),
            status: () => fixturePromise(() => status("starting")),
            logs: (query) =>
              fixturePromise(() => {
                logQueries.push(query);
                return { entries, cursor: { opaque: "v1_1" }, running: false };
              }),
          })),
        removeRoot: (root) =>
          fixturePromise(() => {
            removed.push(root);
          }),
      };
      const failure: unknown = yield* Effect.promise(() =>
        createTestStackWith({}, operations).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) return yield* Effect.die("expected startup failure");
      expect(failure.message).toContain("startup failed");
      expect(failure.message).toContain("pooler stderr");
      expect(failure.message).not.toContain("old-0");
      expect(failure.cause).toEqual(expect.objectContaining({ message: "startup failed" }));
      expect(logQueries).toEqual([{ tail: 50 }]);
      expect(events).toEqual(["start", "destroy"]);
      expect(removed).toEqual(["/tmp/stack-test-diagnostics"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("fails and cleans up when start returns before the stack is ready", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const removed: Array<string> = [];
      const operations: TestStackOperations = {
        createRoot: () => fixturePromise(() => "/tmp/stack-test-unready"),
        createStack: () =>
          fixturePromise(() => ({
            ...fakeStack(events),
            start: () =>
              fixturePromise(() => {
                events.push("start");
                return status("starting");
              }),
          })),
        removeRoot: (root) =>
          fixturePromise(() => {
            removed.push(root);
          }),
      };
      yield* Effect.promise(() =>
        expect(
          createTestStackWith({ config: { capabilities: { database: {} } } }, operations),
        ).rejects.toThrow("Stack did not become ready after start (lifecycle starting)"),
      );
      expect(events).toEqual(["start", "destroy"]);
      expect(removed).toEqual(["/tmp/stack-test-unready"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("removes the exact root after disposal", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const removed: Array<string> = [];
      const operations: TestStackOperations = {
        createRoot: () => fixturePromise(() => "/tmp/stack-test-close-failed"),
        createStack: () => fixturePromise(() => fakeStack(events)),
        removeRoot: (root) =>
          fixturePromise(() => {
            removed.push(root);
          }),
      };
      const stack = yield* Effect.promise(() => createTestStackWith({}, operations));
      yield* Effect.promise(() => expect(stack[Symbol.asyncDispose]()).resolves.toBeUndefined());
      expect(events).toEqual(["start", "destroy"]);
      expect(removed).toEqual(["/tmp/stack-test-close-failed"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("does not require disabled Functions or an unconfigured API listener", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const operations: TestStackOperations = {
        createRoot: () => fixturePromise(() => "/tmp/stack-test-disabled-surfaces"),
        createStack: () =>
          fixturePromise(() => fakeStack(events, { includeApi: false, functionsState: "stopped" })),
        removeRoot: () => fixturePromise(() => undefined),
      };
      const stack = yield* Effect.promise(() =>
        createTestStackWith(
          { config: { capabilities: { functions: { enabled: false } } } },
          operations,
        ),
      );
      yield* Effect.promise(() => stack[Symbol.asyncDispose]());
      expect(events).toEqual(["start", "destroy"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("runs setupProject after creating the root and before creating the stack", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const operations: TestStackOperations = {
        createRoot: () =>
          fixturePromise(() => {
            events.push("root");
            return "/tmp/stack-test-setup";
          }),
        createStack: (options) =>
          fixturePromise(() => {
            events.push(`create:${options.projectRoot}`);
            return fakeStack(events);
          }),
        removeRoot: () =>
          fixturePromise(() => {
            events.push("remove");
          }),
      };
      const stack = yield* Effect.promise(() =>
        createTestStackWith(
          {
            setupProject: (root) =>
              fixturePromise(() => {
                events.push(`setup:${root}`);
              }),
          },
          operations,
        ),
      );
      yield* Effect.promise(() => stack[Symbol.asyncDispose]());
      expect(events).toEqual([
        "root",
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
      const events: Array<string> = [];
      const originalEnvironment = yield* defaultRuntimeEnvironment;
      let environment: Parameters<NonNullable<TestStackOperations["createStack"]>>[1] | undefined;
      const operations: TestStackOperations = {
        createRoot: () => fixturePromise(() => "/tmp/stack-test-isolated-state"),
        createStack: (_options, runtimeEnvironment) =>
          fixturePromise(() => {
            environment = runtimeEnvironment;
            events.push("create");
            return fakeStack(events);
          }),
        removeRoot: () => fixturePromise(() => undefined),
      };
      const stack = yield* Effect.promise(() => createTestStackWith({}, operations));
      yield* Effect.promise(() => stack[Symbol.asyncDispose]());
      expect(environment?.stateRoot).toBe((yield* defaultRuntimeEnvironment).stateRoot);
      expect(environment?.artifactCacheRoot).toBe(
        (yield* Path.Path).join(tmpdir(), "supabase-stack-test-artifacts"),
      );
      expect(environment?.artifactCacheRoot).not.toContain("stack-test-isolated-state");
      // Compare against the snapshot above to prove no global environment mutation occurred.
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
      const events: Array<string> = [];
      let created = false;
      const operations: TestStackOperations = {
        createRoot: () => fixturePromise(() => "/tmp/stack-test-setup-failed"),
        createStack: () =>
          fixturePromise(() => {
            created = true;
            return fakeStack(events);
          }),
        removeRoot: (root) =>
          fixturePromise(() => {
            events.push(`remove:${root}`);
          }),
      };
      yield* Effect.promise(() =>
        expect(
          createTestStackWith(
            {
              setupProject: () =>
                fixturePromise(() => {
                  throw new Error("project setup failed");
                }),
            },
            operations,
          ),
        ).rejects.toThrow("project setup failed"),
      );
      expect(created).toBe(false);
      expect(events).toEqual(["remove:/tmp/stack-test-setup-failed"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("rejects readiness when a configured capability fails", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const removed: Array<string> = [];
      const operations: TestStackOperations = {
        createRoot: () => fixturePromise(() => "/tmp/stack-test-capability-failed"),
        createStack: () => fixturePromise(() => fakeStack(events, { failedCapability: "auth" })),
        removeRoot: (root) =>
          fixturePromise(() => {
            removed.push(root);
          }),
      };
      yield* Effect.promise(() =>
        expect(createTestStackWith({}, operations)).rejects.toThrow("auth failed"),
      );
      expect(events).toEqual(["start", "destroy"]);
      expect(removed).toEqual(["/tmp/stack-test-capability-failed"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("rejects readiness when the lifecycle stops before becoming ready", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const operations: TestStackOperations = {
        createRoot: () => fixturePromise(() => "/tmp/stack-test-lifecycle-stopped"),
        createStack: () =>
          fixturePromise(() => ({
            ...fakeStack(events),
            start: () =>
              fixturePromise(() => {
                events.push("start");
                return status("stopped");
              }),
          })),
        removeRoot: () => fixturePromise(() => undefined),
      };
      yield* Effect.promise(() =>
        expect(createTestStackWith({}, operations)).rejects.toThrow("stopped"),
      );
      expect(events).toEqual(["start", "destroy"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("rejects readiness when the lifecycle starts stopping before becoming ready", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const operations: TestStackOperations = {
        createRoot: () => fixturePromise(() => "/tmp/stack-test-lifecycle-stopping"),
        createStack: () =>
          fixturePromise(() => ({
            ...fakeStack(events),
            start: () =>
              fixturePromise(() => {
                events.push("start");
                return status("stopping");
              }),
          })),
        removeRoot: () => fixturePromise(() => undefined),
      };
      yield* Effect.promise(() =>
        expect(createTestStackWith({}, operations)).rejects.toThrow("stopping"),
      );
      expect(events).toEqual(["start", "destroy"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("uses the managed state root while test stacks overlap", () =>
    Effect.gen(function* () {
      const roots = ["/tmp/stack-test-shared-a", "/tmp/stack-test-shared-b"];
      const environments: Array<Parameters<NonNullable<TestStackOperations["createStack"]>>[1]> =
        [];
      const removedRoots: Array<string> = [];
      const operations: TestStackOperations = {
        createRoot: () =>
          fixturePromise(() => {
            const root = roots.shift();
            if (root === undefined) throw new Error("No test root available");
            return root;
          }),
        createStack: (_options, environment) =>
          fixturePromise(() => {
            environments.push(environment);
            return fakeStack([]);
          }),
        removeRoot: (root) =>
          fixturePromise(() => {
            removedRoots.push(root);
          }),
      };
      const [first, second] = yield* Effect.promise(() =>
        Promise.all([createTestStackWith({}, operations), createTestStackWith({}, operations)]),
      );
      expect(environments.map((environment) => environment?.stateRoot)).toEqual([
        (yield* defaultRuntimeEnvironment).stateRoot,
        (yield* defaultRuntimeEnvironment).stateRoot,
      ]);
      yield* Effect.promise(() => first[Symbol.asyncDispose]());
      yield* Effect.promise(() => second[Symbol.asyncDispose]());
      expect(removedRoots).toEqual(["/tmp/stack-test-shared-a", "/tmp/stack-test-shared-b"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("creates auto roots under the managed state root and cleans up the exact root", () =>
    Effect.gen(function* () {
      let setupRoot: string | undefined;
      let createdRoot: string | undefined;
      let removedRoot: string | undefined;
      const stack = yield* Effect.promise(() =>
        createTestStackWith(
          {
            setupProject: (root) =>
              fixturePromise(() => {
                setupRoot = root;
              }),
          },
          {
            createStack: (options) =>
              fixturePromise(() => {
                createdRoot = options.projectRoot;
                return fakeStack([]);
              }),
            removeRoot: (root) =>
              fixturePromise(() => {
                removedRoot = root;
              }),
          },
        ),
      );
      const managedRoot = (yield* defaultRuntimeEnvironment).stateRoot;
      const { join, dirname, sep } = yield* Path.Path;
      const projectsRoot = join(dirname(managedRoot), "test-projects");
      expect(setupRoot).toBe(createdRoot);
      expect(createdRoot?.startsWith(`${projectsRoot}${sep}`)).toBe(true);
      if (!managedRoot.startsWith(`${tmpdir()}${sep}`))
        expect(createdRoot?.startsWith(`${tmpdir()}${sep}`)).toBe(false);
      yield* Effect.promise(() => stack[Symbol.asyncDispose]());
      expect(removedRoot).toBe(createdRoot);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("retains the project root and managed state when one stack destroy fails", () =>
    Effect.gen(function* () {
      const roots = ["/tmp/stack-test-retained-a", "/tmp/stack-test-retained-b"];
      const removedRoots: Array<string> = [];
      const environments: Array<Parameters<NonNullable<TestStackOperations["createStack"]>>[1]> =
        [];
      const operations: TestStackOperations = {
        createRoot: () =>
          fixturePromise(() => {
            const root = roots.shift();
            if (root === undefined) throw new Error("No test root available");
            return root;
          }),
        createStack: (options, environment) =>
          fixturePromise(() => {
            environments.push(environment);
            return {
              ...fakeStack([]),
              destroy: () =>
                fixturePromise(() => {
                  if (options.projectRoot.endsWith("-a")) throw new Error("destroy a failed");
                }),
            };
          }),
        removeRoot: (root) =>
          fixturePromise(() => {
            removedRoots.push(root);
          }),
      };
      const [first, second] = yield* Effect.promise(() =>
        Promise.all([createTestStackWith({}, operations), createTestStackWith({}, operations)]),
      );
      yield* Effect.promise(() =>
        expect(first[Symbol.asyncDispose]()).rejects.toThrow(
          "destroy a failed; retained test stack root /tmp/stack-test-retained-a",
        ),
      );
      yield* Effect.promise(() => second[Symbol.asyncDispose]());
      expect(removedRoots).toEqual(["/tmp/stack-test-retained-b"]);
      expect(environments.map((environment) => environment?.stateRoot)).toEqual([
        (yield* defaultRuntimeEnvironment).stateRoot,
        (yield* defaultRuntimeEnvironment).stateRoot,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
