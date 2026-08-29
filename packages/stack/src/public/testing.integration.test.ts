import { describe, expect, it } from "vitest";
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

const status = (lifecycle: StackStatus["lifecycle"]): StackStatus => ({
  id: stackId,
  lifecycle,
  desiredLifecycle:
    lifecycle === "starting" || lifecycle === "stopping"
      ? "running"
      : lifecycle === "resetting-database"
        ? "running"
        : lifecycle,
  runtime: { kind: "native" },
  endpoints:
    lifecycle === "running"
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
    state: lifecycle === "running" ? (name === "functions" ? "dormant" : "ready") : "stopped",
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
): PromiseStack => ({
  id: stackId,
  status: async () => status("running"),
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
    return status("starting");
  },
  restart: async () => status("running"),
  stop: async () => undefined,
  destroy: async () => {
    events.push("destroy");
    if (failStart) throw new Error("destroy failed");
  },
  close: async () => {
    events.push("close");
  },
  watchStatus: () => stream([status(reachesReadiness ? "running" : "starting")]),
  logs: () => stream([]),
});

describe("test stack resource", () => {
  it("starts, waits for readiness, and destroys only its owned identity", async () => {
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
    await expect(createTestStackWith({}, operations)).rejects.toThrow(
      "did not reach running readiness",
    );
    expect(events).toEqual(["start", "destroy", "close"]);
    expect(removed).toEqual(["/tmp/stack-test-unready"]);
  });
});
