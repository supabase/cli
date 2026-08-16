import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { BunServices } from "@effect/platform-bun";
import { createManagedStackService, managedDaemonLayer } from "./managed-bun.ts";
import { unixHttpClientLayer } from "./platform-bun.ts";
import { portFieldsForConfigInput } from "./ServicePorts.ts";
import { Stack } from "./Stack.ts";
import type { ManagedStackProjection } from "./managed/model.ts";
import type { ManagedDaemonStartInput } from "./managed-daemon.ts";
import { managedDaemonLayer as managedDaemonLayerWithEntryPoint } from "./managed-daemon.ts";
import {
  MANAGED_DAEMON_TEST_PORT_MARKER,
  managedDaemonTestEntryPoint,
} from "./managed-daemon-test-bun.ts";

const roots: string[] = [];
const childPids = new Set<number>();

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntil = async (predicate: () => Promise<boolean> | boolean): Promise<void> => {
  const deadline = Date.now() + 8_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for managed daemon cleanup");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const stopPid = async (pid: number): Promise<void> => {
  if (!isAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  try {
    await waitUntil(() => !isAlive(pid));
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    await waitUntil(() => !isAlive(pid));
  }
};

const makeMinimalConfig = (workspacePath: string) => ({
  projectDir: workspacePath,
  mode: "native" as const,
  postgrest: false as const,
  auth: false as const,
  edgeRuntime: false as const,
  realtime: false as const,
  storage: false as const,
  imgproxy: false as const,
  mailpit: false as const,
  pgmeta: false as const,
  studio: false as const,
  analytics: false as const,
  vector: false as const,
  pooler: false as const,
});

const makeAllServicesConfig = (workspacePath: string) => ({
  projectDir: workspacePath,
  mode: "native" as const,
  postgrest: {},
  auth: {},
  edgeRuntime: { enabled: true },
  realtime: {},
  storage: {},
  imgproxy: {},
  mailpit: {},
  pgmeta: {},
  studio: {},
  analytics: {},
  vector: {},
  pooler: {},
});

const makeInput = (
  root: string,
  config: ManagedDaemonStartInput["config"],
  socketName = "daemon.sock",
): ManagedDaemonStartInput => {
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  return {
    workspacePath,
    stackName: "default",
    stateRoot: join(root, "state"),
    config,
    effectiveConfig: {},
    valueOrigins: [],
    socketPath: join(root, "runtime", socketName),
  };
};

const startLoopback = async (input: ManagedDaemonStartInput) =>
  Effect.runPromise(
    managedDaemonLayerWithEntryPoint(input, managedDaemonTestEntryPoint).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, unixHttpClientLayer)),
    ),
  );

const readPortMarker = (path: string): Readonly<Record<string, number>> => {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid loopback port marker");
  }
  const entries = Object.entries(value);
  const result: Record<string, number> = {};
  for (const [field, port] of entries) {
    if (typeof port !== "number") throw new Error(`Invalid port marker field ${field}`);
    result[field] = port;
  }
  return result;
};

const connectPort = async (port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });

const assertPortHeld = async (port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
        resolve();
      } else {
        reject(error);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => reject(new Error(`Port ${port} was not held by the child`)));
    });
  });

const assertPortFree = async (port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
  });

const waitForLifecycle = async (stateRoot: string, lifecycle: string): Promise<void> => {
  await waitUntil(async () => {
    const registry = await createManagedStackService({ stateRoot });
    try {
      const stacks = await registry.listStacks();
      return stacks.length === 1 && stacks[0]?.lifecycle === lifecycle;
    } finally {
      await registry.close();
    }
  });
};

afterEach(async () => {
  for (const pid of childPids) await stopPid(pid);
  childPids.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("managed daemon", () => {
  it("allocates and publishes the runtime from the child process", async () => {
    const root = mkdtempSync(join(tmpdir(), "stack-managed-daemon-"));
    roots.push(root);
    const input = makeInput(root, makeMinimalConfig(join(root, "workspace")));
    const layer = await Effect.runPromise(
      managedDaemonLayer(input).pipe(
        Effect.provide(Layer.mergeAll(BunServices.layer, unixHttpClientLayer)),
      ),
    );
    const runtime = ManagedRuntime.make(layer);
    let stack: Stack["Service"] | undefined;
    try {
      stack = Context.get(await runtime.context(), Stack);
      const info = await runtime.runPromise(stack.getInfo());
      const health = await fetch(`${info.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.text()).toBe("OK");
      const registry = await createManagedStackService({ stateRoot: input.stateRoot });
      try {
        const stacks = await registry.listStacks();
        expect(stacks).toHaveLength(1);
        expect(stacks[0]?.lifecycle).toBe("running");
        expect(stacks[0]?.ports.map((assignment) => assignment.key)).toEqual(
          expect.arrayContaining(["api.port", "db.port"]),
        );
        const pid = stacks[0]?.runtimeMetadata.pid;
        if (pid !== undefined) childPids.add(pid);
      } finally {
        await registry.close();
      }
      expect(portFieldsForConfigInput(input.config)).toEqual(["apiPort", "dbPort"]);
    } finally {
      if (stack !== undefined) {
        try {
          await runtime.runPromise(stack.stop());
        } catch {}
      }
      await runtime.dispose();
    }
  });

  it("hands every allocated port to child listeners before acknowledging publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "stack-managed-daemon-loopback-"));
    roots.push(root);
    const config = makeAllServicesConfig(join(root, "workspace"));
    const input = makeInput(root, config);
    await startLoopback(input);
    const registry = await createManagedStackService({ stateRoot: input.stateRoot });
    let pid: number | undefined;
    let ports: Readonly<Record<string, number>> = {};
    let stackId = "";
    try {
      const stacks = await registry.listStacks();
      expect(stacks).toHaveLength(1);
      expect(stacks[0]?.lifecycle).toBe("running");
      const stack = stacks[0];
      if (stack === undefined) throw new Error("missing published stack");
      stackId = stack.id;
      pid = stack.runtimeMetadata.pid;
      if (pid === undefined) throw new Error("missing managed daemon pid");
      childPids.add(pid);
      ports = readPortMarker(join(stack.paths.runtime, MANAGED_DAEMON_TEST_PORT_MARKER));
      const fields = portFieldsForConfigInput(config);
      expect(fields).toHaveLength(18);
      expect(Object.keys(ports).sort()).toEqual([...fields].sort());
      for (const field of fields) {
        const port = ports[field];
        if (port === undefined) throw new Error(`missing allocated port ${field}`);
        await connectPort(port);
        await assertPortHeld(port);
      }
    } finally {
      await registry.close();
    }
    if (pid === undefined) throw new Error("missing managed daemon pid");
    await stopPid(pid);
    childPids.delete(pid);
    await waitForLifecycle(input.stateRoot, "stopped");
    for (const port of Object.values(ports)) await assertPortFree(port);
    expect(stackId).toBeTruthy();
  });

  it("reuses an already-running managed daemon through its published socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "stack-managed-daemon-reuse-"));
    roots.push(root);
    const workspacePath = join(root, "workspace");
    const config = makeMinimalConfig(workspacePath);
    const first = makeInput(root, config, "first.sock");
    const second = makeInput(root, config, "first.sock");

    const firstLayer = await Effect.runPromise(
      managedDaemonLayer(first).pipe(
        Effect.provide(Layer.mergeAll(BunServices.layer, unixHttpClientLayer)),
      ),
    );
    const firstRuntime = ManagedRuntime.make(firstLayer);
    let firstStack: Stack["Service"] | undefined;
    let originalRecord: ManagedStackProjection | undefined;
    try {
      firstStack = Context.get(await firstRuntime.context(), Stack);
      const registry = await createManagedStackService({ stateRoot: first.stateRoot });
      try {
        const stacks = await registry.listStacks();
        const record = stacks[0];
        if (record === undefined) throw new Error("missing first daemon record");
        originalRecord = record;
        const pid = record.runtimeMetadata.pid;
        if (pid === undefined) throw new Error("missing first daemon pid");
        childPids.add(pid);
        expect(isAlive(pid)).toBe(true);
      } finally {
        await registry.close();
      }
      const firstInfo = await firstRuntime.runPromise(firstStack.getInfo());
      const secondLayer = await Effect.runPromise(
        managedDaemonLayer(second).pipe(
          Effect.provide(Layer.mergeAll(BunServices.layer, unixHttpClientLayer)),
        ),
      );
      const secondRuntime = ManagedRuntime.make(secondLayer);
      try {
        const secondStack = Context.get(await secondRuntime.context(), Stack);
        const secondInfo = await secondRuntime.runPromise(secondStack.getInfo());
        expect(secondInfo.url).toBe(firstInfo.url);
        const registry = await createManagedStackService({ stateRoot: first.stateRoot });
        try {
          const stacks = await registry.listStacks();
          expect(stacks).toEqual([originalRecord]);
        } finally {
          await registry.close();
        }
      } finally {
        await secondRuntime.dispose();
      }
    } finally {
      if (firstStack !== undefined) {
        try {
          await firstRuntime.runPromise(firstStack.stop());
        } catch {}
      }
      await firstRuntime.dispose();
    }
  });

  it("records post-claim bootstrap failure and releases every allocated listener", async () => {
    const root = mkdtempSync(join(tmpdir(), "stack-managed-daemon-failure-"));
    roots.push(root);
    const config = makeAllServicesConfig(join(root, "workspace"));
    const input = makeInput(root, config, "failure.sock");
    await expect(startLoopback(input)).rejects.toThrow();
    const registry = await createManagedStackService({ stateRoot: input.stateRoot });
    try {
      const stacks = await registry.listStacks();
      expect(stacks).toHaveLength(1);
      const stack = stacks[0];
      if (stack === undefined) throw new Error("missing failed stack");
      expect(stack.lifecycle).toBe("failed");
      const ports = readPortMarker(join(stack.paths.runtime, MANAGED_DAEMON_TEST_PORT_MARKER));
      expect(Object.keys(ports).sort()).toEqual([...portFieldsForConfigInput(config)].sort());
      for (const port of Object.values(ports)) await assertPortFree(port);
    } finally {
      await registry.close();
    }
  });

  it("starts two isolated managed children concurrently with disjoint listeners", async () => {
    const firstRoot = mkdtempSync(join(tmpdir(), "stack-managed-daemon-concurrent-a-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "stack-managed-daemon-concurrent-b-"));
    roots.push(firstRoot, secondRoot);
    const first = makeInput(firstRoot, makeAllServicesConfig(join(firstRoot, "workspace")));
    const second = makeInput(secondRoot, makeAllServicesConfig(join(secondRoot, "workspace")));
    await Promise.all([startLoopback(first), startLoopback(second)]);
    const records = await Promise.all(
      [first, second].map(async (input) => {
        const registry = await createManagedStackService({ stateRoot: input.stateRoot });
        try {
          const stacks = await registry.listStacks();
          expect(stacks).toHaveLength(1);
          const stack = stacks[0];
          if (stack === undefined || stack.runtimeMetadata.pid === undefined) {
            throw new Error("missing concurrent stack metadata");
          }
          childPids.add(stack.runtimeMetadata.pid);
          return {
            input,
            pid: stack.runtimeMetadata.pid,
            ports: readPortMarker(join(stack.paths.runtime, MANAGED_DAEMON_TEST_PORT_MARKER)),
          };
        } finally {
          await registry.close();
        }
      }),
    );
    const firstRecord = records[0];
    const secondRecord = records[1];
    if (firstRecord === undefined || secondRecord === undefined) {
      throw new Error("missing concurrent records");
    }
    const firstPorts = new Set(Object.values(firstRecord.ports));
    for (const port of Object.values(secondRecord.ports)) {
      expect(firstPorts.has(port)).toBe(false);
    }
    for (const record of records) {
      for (const port of Object.values(record.ports)) {
        await connectPort(port);
        await assertPortHeld(port);
      }
    }
    for (const record of records) {
      await stopPid(record.pid);
      childPids.delete(record.pid);
      await waitForLifecycle(record.input.stateRoot, "stopped");
      for (const port of Object.values(record.ports)) await assertPortFree(port);
    }
  });

  it("rejects a conflicting exact port before publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "stack-managed-daemon-exact-conflict-"));
    roots.push(root);
    const workspacePath = join(root, "workspace");
    const stateRoot = join(root, "state");
    mkdirSync(workspacePath, { recursive: true });
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", () => resolve());
    });
    const address = occupied.address();
    if (address === null || typeof address === "string") throw new Error("missing test port");
    const port = address.port;
    const config = { ...makeMinimalConfig(workspacePath), port };
    const input: ManagedDaemonStartInput = {
      ...makeInput(root, config),
      effectiveConfig: { api: { port } },
      valueOrigins: [{ path: ["api", "port"], source: "local" }],
    };
    try {
      await expect(
        Effect.runPromise(
          managedDaemonLayer(input).pipe(
            Effect.provide(Layer.mergeAll(BunServices.layer, unixHttpClientLayer)),
          ),
        ),
      ).rejects.toThrow();
      const registry = await createManagedStackService({ stateRoot });
      try {
        const stacks = await registry.listStacks();
        expect(stacks).toHaveLength(0);
      } finally {
        await registry.close();
      }
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});
