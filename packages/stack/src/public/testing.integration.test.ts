import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- this fixture asserts exact root paths.
import { dirname, join, sep } from "node:path";
import type { PromiseStack } from "./PromiseStack.ts";
import { createTestStackWith, type TestStackOperations } from "./Testing.ts";
import { defaultRuntimeEnvironment } from "../supervisor/Launcher.ts";
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
  includeApi = true,
  functionsState: "ready" | "dormant" | "stopped" = "dormant",
  failedCapability?: string,
): PromiseStack => ({
  id: stackId,
  status: async () =>
    status(reachesReadiness ? "running" : "stopped", includeApi, functionsState, failedCapability),
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
    return status(
      reachesReadiness ? "running" : "stopped",
      includeApi,
      functionsState,
      failedCapability,
    );
  },
  stop: async () => undefined,
  destroy: async () => {
    events.push("destroy");
    if (failStart) throw new Error("destroy failed");
  },
  logs: async () => ({ entries: [], cursor: { opaque: "v1_0" }, running: false }),
  followLogs: () => stream([]),
});

describe("test stack resource", () => {
  it("starts automatically and destroys only its owned identity", async () => {
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
    expect(events).toEqual(["create:/tmp/stack-test-owned", "start", "destroy"]);
    expect(removed).toEqual(["/tmp/stack-test-owned"]);
  });

  it("preserves startup failure while retaining the root when destroy fails", async () => {
    const events: Array<string> = [];
    const removed: Array<string> = [];
    const operations: TestStackOperations = {
      createRoot: async () => "/tmp/stack-test-failed",
      createStack: async () => fakeStack(events, true),
      removeRoot: async (root) => {
        removed.push(root);
      },
    };
    let failure: unknown;
    try {
      await createTestStackWith({}, operations);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("expected startup failure");
    expect(failure.message).toContain("startup failed");
    expect(failure.message).toContain("retained test stack root /tmp/stack-test-failed");
    expect(events).toEqual(["start", "destroy"]);
    expect(removed).toEqual([]);
  });

  it("includes bounded startup diagnostics before cleanup removes a failed stack", async () => {
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
      createRoot: async () => "/tmp/stack-test-diagnostics",
      createStack: async () => ({
        ...fakeStack(events),
        start: async () => {
          events.push("start");
          throw new Error("startup failed");
        },
        status: async () => status("starting"),
        logs: async (query) => {
          logQueries.push(query);
          return { entries, cursor: { opaque: "v1_1" }, running: false };
        },
      }),
      removeRoot: async (root) => {
        removed.push(root);
      },
    };

    let failure: unknown;
    try {
      await createTestStackWith({}, operations);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("expected startup failure");
    expect(failure.message).toContain("startup failed");
    expect(failure.message).toContain("pooler stderr");
    expect(failure.message).not.toContain("old-0");
    expect(failure.cause).toEqual(expect.objectContaining({ message: "startup failed" }));
    expect(logQueries).toEqual([{ tail: 50 }]);
    expect(events).toEqual(["start", "destroy"]);
    expect(removed).toEqual(["/tmp/stack-test-diagnostics"]);
  });

  it("fails and cleans up when start returns before the stack is ready", async () => {
    const events: Array<string> = [];
    const removed: Array<string> = [];
    const operations: TestStackOperations = {
      createRoot: async () => "/tmp/stack-test-unready",
      createStack: async () => ({
        ...fakeStack(events),
        start: async () => {
          events.push("start");
          return status("starting");
        },
      }),
      removeRoot: async (root) => {
        removed.push(root);
      },
    };
    await expect(
      createTestStackWith({ config: { capabilities: { database: {} } } }, operations),
    ).rejects.toThrow("Stack did not become ready after start (lifecycle starting)");
    expect(events).toEqual(["start", "destroy"]);
    expect(removed).toEqual(["/tmp/stack-test-unready"]);
  });

  it("removes the exact root after disposal", async () => {
    const events: Array<string> = [];
    const removed: Array<string> = [];
    const operations: TestStackOperations = {
      createRoot: async () => "/tmp/stack-test-close-failed",
      createStack: async () => fakeStack(events),
      removeRoot: async (root) => {
        removed.push(root);
      },
    };
    const stack = await createTestStackWith({}, operations);
    await expect(stack[Symbol.asyncDispose]()).resolves.toBeUndefined();
    expect(events).toEqual(["start", "destroy"]);
    expect(removed).toEqual(["/tmp/stack-test-close-failed"]);
  });

  it("does not require disabled Functions or an unconfigured API listener", async () => {
    const events: Array<string> = [];
    const operations: TestStackOperations = {
      createRoot: async () => "/tmp/stack-test-disabled-surfaces",
      createStack: async () => fakeStack(events, false, true, false, "stopped"),
      removeRoot: async () => undefined,
    };
    const stack = await createTestStackWith(
      { config: { capabilities: { functions: { enabled: false } } } },
      operations,
    );
    await stack[Symbol.asyncDispose]();
    expect(events).toEqual(["start", "destroy"]);
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
      "remove",
    ]);
  });

  it("uses the managed runtime state root without mutating process environment", async () => {
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
    expect(environment?.stateRoot).toBe(defaultRuntimeEnvironment().stateRoot);
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
      createStack: async () => fakeStack(events, false, true, true, "dormant", "auth"),
      removeRoot: async (root) => {
        removed.push(root);
      },
    };
    await expect(createTestStackWith({}, operations)).rejects.toThrow("auth failed");
    expect(events).toEqual(["start", "destroy"]);
    expect(removed).toEqual(["/tmp/stack-test-capability-failed"]);
  });

  it("rejects readiness when the lifecycle stops before becoming ready", async () => {
    const events: Array<string> = [];
    const operations: TestStackOperations = {
      createRoot: async () => "/tmp/stack-test-lifecycle-stopped",
      createStack: async () => ({
        ...fakeStack(events),
        start: async () => {
          events.push("start");
          return status("stopped");
        },
      }),
      removeRoot: async () => undefined,
    };
    await expect(createTestStackWith({}, operations)).rejects.toThrow("stopped");
    expect(events).toEqual(["start", "destroy"]);
  });

  it("rejects readiness when the lifecycle starts stopping before becoming ready", async () => {
    const events: Array<string> = [];
    const operations: TestStackOperations = {
      createRoot: async () => "/tmp/stack-test-lifecycle-stopping",
      createStack: async () => ({
        ...fakeStack(events),
        start: async () => {
          events.push("start");
          return status("stopping");
        },
      }),
      removeRoot: async () => undefined,
    };
    await expect(createTestStackWith({}, operations)).rejects.toThrow("stopping");
    expect(events).toEqual(["start", "destroy"]);
  });

  it("uses the managed state root while test stacks overlap", async () => {
    const roots = ["/tmp/stack-test-shared-a", "/tmp/stack-test-shared-b"];
    const environments: Array<Parameters<NonNullable<TestStackOperations["createStack"]>>[1]> = [];
    const removedRoots: Array<string> = [];
    const operations: TestStackOperations = {
      createRoot: async () => {
        const root = roots.shift();
        if (root === undefined) throw new Error("No test root available");
        return root;
      },
      createStack: async (_options, environment) => {
        environments.push(environment);
        return fakeStack([]);
      },
      removeRoot: async (root) => {
        removedRoots.push(root);
      },
    };
    const [first, second] = await Promise.all([
      createTestStackWith({}, operations),
      createTestStackWith({}, operations),
    ]);
    expect(environments.map((environment) => environment?.stateRoot)).toEqual([
      defaultRuntimeEnvironment().stateRoot,
      defaultRuntimeEnvironment().stateRoot,
    ]);
    await first[Symbol.asyncDispose]();
    await second[Symbol.asyncDispose]();
    expect(removedRoots).toEqual(["/tmp/stack-test-shared-a", "/tmp/stack-test-shared-b"]);
  });

  it("creates auto roots under the managed state root and cleans up the exact root", async () => {
    let setupRoot: string | undefined;
    let createdRoot: string | undefined;
    let removedRoot: string | undefined;
    const stack = await createTestStackWith(
      {
        setupProject: async (root) => {
          setupRoot = root;
        },
      },
      {
        createStack: async (options) => {
          createdRoot = options.projectRoot;
          return fakeStack([]);
        },
        removeRoot: async (root) => {
          removedRoot = root;
        },
      },
    );
    const managedRoot = defaultRuntimeEnvironment().stateRoot;
    const projectsRoot = join(dirname(managedRoot), "test-projects");
    expect(setupRoot).toBe(createdRoot);
    expect(createdRoot?.startsWith(`${projectsRoot}${sep}`)).toBe(true);
    if (!managedRoot.startsWith(`${tmpdir()}${sep}`))
      expect(createdRoot?.startsWith(`${tmpdir()}${sep}`)).toBe(false);
    await stack[Symbol.asyncDispose]();
    expect(removedRoot).toBe(createdRoot);
  });

  it("retains the project root and managed state when one stack destroy fails", async () => {
    const roots = ["/tmp/stack-test-retained-a", "/tmp/stack-test-retained-b"];
    const removedRoots: Array<string> = [];
    const environments: Array<Parameters<NonNullable<TestStackOperations["createStack"]>>[1]> = [];
    const operations: TestStackOperations = {
      createRoot: async () => {
        const root = roots.shift();
        if (root === undefined) throw new Error("No test root available");
        return root;
      },
      createStack: async (options, environment) => {
        environments.push(environment);
        return {
          ...fakeStack([]),
          destroy: async () => {
            if (options.projectRoot.endsWith("-a")) throw new Error("destroy a failed");
          },
        };
      },
      removeRoot: async (root) => {
        removedRoots.push(root);
      },
    };
    const [first, second] = await Promise.all([
      createTestStackWith({}, operations),
      createTestStackWith({}, operations),
    ]);
    await expect(first[Symbol.asyncDispose]()).rejects.toThrow(
      "destroy a failed; retained test stack root /tmp/stack-test-retained-a",
    );
    await second[Symbol.asyncDispose]();
    expect(removedRoots).toEqual(["/tmp/stack-test-retained-b"]);
    expect(environments.map((environment) => environment?.stateRoot)).toEqual([
      defaultRuntimeEnvironment().stateRoot,
      defaultRuntimeEnvironment().stateRoot,
    ]);
  });
});
