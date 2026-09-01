import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- this fixture asserts exact root paths.
import { join } from "node:path";
import type { PromiseStack } from "./PromiseStack.ts";
import { createTestStackWith, type TestStackOperations } from "./Testing.ts";
import { CAPABILITY_NAMES } from "./Capability.ts";
import { StackIdSchema } from "./StackId.ts";
import type { StackStatus } from "./Status.ts";

// Promise facade fixtures intentionally model async operations.
// oxlint-disable effecttsgo/async-function

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
});

const stream = <A>(values: ReadonlyArray<A>): AsyncIterable<A> => ({
  async *[Symbol.asyncIterator]() {
    yield* values;
  },
});

const fakeStack = (
  events: Array<string>,
  failStart = false,
  reachesReadiness = true,
  failClose = false,
  includeApi = true,
  functionsState: "ready" | "dormant" | "stopped" = "dormant",
  failedCapability?: string,
): PromiseStack => ({
  id: stackId,
  status: async () => status("running", includeApi, functionsState),
  credentials: async () => ({
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
  }),
  prepare: async () => ({ capabilities: [] }),
  start: async () => {
    events.push("start");
    if (failStart) throw new Error("startup failed");
    return status("starting", includeApi, functionsState);
  },
  restart: async () => status("running"),
  stop: async () => undefined,
  destroy: async () => {
    events.push("destroy");
    if (failStart) throw new Error("destroy failed");
  },
  close: async () => {
    events.push("close");
    if (failClose) throw new Error("close failed");
  },
  watchStatus: () =>
    stream([
      status(
        reachesReadiness ? "running" : "starting",
        includeApi,
        functionsState,
        failedCapability,
      ),
    ]),
  logs: () => stream([]),
});

describe("test stack resource", () => {
  it("starts with default-disabled pooler readiness and destroys only its owned identity", async () => {
    const events: Array<string> = [];
    const removed: Array<string> = [];
    const operations: TestStackOperations = {
      createRoot: async () => "/tmp/stack-test-owned",
      createStack: async (options) => {
        events.push(`create:${options.projectRoot}`);
        return fakeStack(events);
      },
      removeRoot: async (root) => {
        removed.push(root);
      },
    };
    const stack = await createTestStackWith({}, operations);
    await stack[Symbol.asyncDispose]();
    expect(events).toEqual(["create:/tmp/stack-test-owned", "start", "destroy", "close"]);
    expect(removed).toEqual(["/tmp/stack-test-owned"]);
  });

  it("preserves startup failure while cleaning up destroy, close, and temporary root", async () => {
    const events: Array<string> = [];
    const removed: Array<string> = [];
    const operations: TestStackOperations = {
      createRoot: async () => "/tmp/stack-test-failed",
      createStack: async () => fakeStack(events, true),
      removeRoot: async (root) => {
        removed.push(root);
      },
    };
    await expect(createTestStackWith({}, operations)).rejects.toThrow("startup failed");
    expect(events).toEqual(["start", "destroy", "close"]);
    expect(removed).toEqual(["/tmp/stack-test-failed"]);
  });

  it("fails and cleans up when readiness status ends before becoming ready", async () => {
    const events: Array<string> = [];
    const removed: Array<string> = [];
    const operations: TestStackOperations = {
      createRoot: async () => "/tmp/stack-test-unready",
      createStack: async () => fakeStack(events, false, false),
      removeRoot: async (root) => {
        removed.push(root);
      },
    };
    await expect(
      createTestStackWith({ config: { capabilities: { database: {} } } }, operations),
    ).rejects.toThrow("did not reach running readiness");
    expect(events).toEqual(["start", "destroy", "close"]);
    expect(removed).toEqual(["/tmp/stack-test-unready"]);
  });

  it("removes the exact root when disposal close fails and preserves that primary error", async () => {
    const events: Array<string> = [];
    const removed: Array<string> = [];
    const operations: TestStackOperations = {
      createRoot: async () => "/tmp/stack-test-close-failed",
      createStack: async () => fakeStack(events, false, true, true),
      removeRoot: async (root) => {
        removed.push(root);
      },
    };
    const stack = await createTestStackWith({}, operations);
    await expect(stack[Symbol.asyncDispose]()).rejects.toThrow("close failed");
    expect(events).toEqual(["start", "destroy", "close"]);
    expect(removed).toEqual(["/tmp/stack-test-close-failed"]);
  });

  it("does not require disabled Functions or an unconfigured API listener", async () => {
    const events: Array<string> = [];
    const operations: TestStackOperations = {
      createRoot: async () => "/tmp/stack-test-disabled-surfaces",
      createStack: async () => fakeStack(events, false, true, false, false, "stopped"),
      removeRoot: async () => undefined,
    };
    const stack = await createTestStackWith(
      { config: { capabilities: { functions: { enabled: false } } } },
      operations,
    );
    await stack[Symbol.asyncDispose]();
    expect(events).toEqual(["start", "destroy", "close"]);
  });

  it("runs setupProject after creating the root and before creating the stack", async () => {
    const events: Array<string> = [];
    const operations: TestStackOperations = {
      createRoot: async () => {
        events.push("root");
        return "/tmp/stack-test-setup";
      },
      createStack: async (options) => {
        events.push(`create:${options.projectRoot}`);
        return fakeStack(events);
      },
      removeRoot: async () => {
        events.push("remove");
      },
    };
    const stack = await createTestStackWith(
      {
        setupProject: async (root) => {
          events.push(`setup:${root}`);
        },
      },
      operations,
    );
    await stack[Symbol.asyncDispose]();
    expect(events).toEqual([
      "root",
      "setup:/tmp/stack-test-setup",
      "create:/tmp/stack-test-setup",
      "start",
      "destroy",
      "close",
      "remove",
    ]);
  });

  it("passes an isolated runtime state root without mutating process environment", async () => {
    const events: Array<string> = [];
    // This read is the assertion that createTestStackWith leaves global environment untouched.
    // oxlint-disable-next-line effecttsgo/process-env -- test-only environment immutability assertion.
    const originalHome = process.env.SUPABASE_HOME;
    let environment: Parameters<NonNullable<TestStackOperations["createStack"]>>[1] | undefined;
    const operations: TestStackOperations = {
      createRoot: async () => "/tmp/stack-test-isolated-state",
      createStack: async (_options, runtimeEnvironment) => {
        environment = runtimeEnvironment;
        events.push("create");
        return fakeStack(events);
      },
      removeRoot: async () => undefined,
    };
    const stack = await createTestStackWith({}, operations);
    await stack[Symbol.asyncDispose]();
    expect(environment?.stateRoot).toBe("/tmp/stack-test-isolated-state/.supabase/managed/stacks");
    expect(environment?.stateRoot.startsWith("/tmp/stack-test-isolated-state/")).toBe(true);
    expect(environment?.artifactCacheRoot).toBe(join(tmpdir(), "supabase-stack-test-artifacts"));
    expect(environment?.artifactCacheRoot).not.toContain("stack-test-isolated-state");
    // Compare against the snapshot above to prove no global environment mutation occurred.
    // oxlint-disable-next-line effecttsgo/process-env -- test-only environment immutability assertion.
    expect(process.env.SUPABASE_HOME).toBe(originalHome);
  });

  it("removes the exact root when setupProject fails", async () => {
    const events: Array<string> = [];
    let created = false;
    const operations: TestStackOperations = {
      createRoot: async () => "/tmp/stack-test-setup-failed",
      createStack: async () => {
        created = true;
        return fakeStack(events);
      },
      removeRoot: async (root) => {
        events.push(`remove:${root}`);
      },
    };
    await expect(
      createTestStackWith(
        {
          setupProject: async () => {
            throw new Error("project setup failed");
          },
        },
        operations,
      ),
    ).rejects.toThrow("project setup failed");
    expect(created).toBe(false);
    expect(events).toEqual(["remove:/tmp/stack-test-setup-failed"]);
  });

  it("rejects readiness when a configured capability fails", async () => {
    const events: Array<string> = [];
    const removed: Array<string> = [];
    const operations: TestStackOperations = {
      createRoot: async () => "/tmp/stack-test-capability-failed",
      createStack: async () => fakeStack(events, false, true, false, true, "dormant", "auth"),
      removeRoot: async (root) => {
        removed.push(root);
      },
    };
    await expect(createTestStackWith({}, operations)).rejects.toThrow("auth failed");
    expect(events).toEqual(["start", "destroy", "close"]);
    expect(removed).toEqual(["/tmp/stack-test-capability-failed"]);
  });

  it("rejects readiness when the lifecycle stops before becoming ready", async () => {
    const events: Array<string> = [];
    const operations: TestStackOperations = {
      createRoot: async () => "/tmp/stack-test-lifecycle-stopped",
      createStack: async () => ({
        ...fakeStack(events),
        watchStatus: () => stream([status("stopped")]),
      }),
      removeRoot: async () => undefined,
    };
    await expect(createTestStackWith({}, operations)).rejects.toThrow("stopped");
    expect(events).toEqual(["start", "destroy", "close"]);
  });

  it("rejects readiness when the lifecycle starts stopping before becoming ready", async () => {
    const events: Array<string> = [];
    const operations: TestStackOperations = {
      createRoot: async () => "/tmp/stack-test-lifecycle-stopping",
      createStack: async () => ({
        ...fakeStack(events),
        watchStatus: () => stream([status("stopping")]),
      }),
      removeRoot: async () => undefined,
    };
    await expect(createTestStackWith({}, operations)).rejects.toThrow("stopping");
    expect(events).toEqual(["start", "destroy", "close"]);
  });
});
