import { Cause, Context, Effect, Layer } from "effect";
import { fork, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { Stack } from "./Stack.ts";
import { RemoteStack } from "./RemoteStack.ts";
import { httpTransportClientLayer } from "./HttpTransportClient.ts";
import { managedDaemonLayer } from "./supervisor.ts";
import { managedStackDocumentPath, managedStackPaths } from "./managed/paths.ts";
import { resolveConfig } from "./StackConfigResolver.ts";
import { controlEndpoint, type ControlEndpoint } from "./managed/control.ts";
import type { SupervisorStartMessage, SupervisorStartedMessage } from "./supervisor.ts";

const childEntryPoint = fileURLToPath(new URL("./daemon-node.ts", import.meta.url));
const bunExecutable = process.env["BUN_EXECUTABLE"] ?? "bun";

interface ChildHandle {
  readonly child: ChildProcess;
  readonly started: Promise<SupervisorStartedMessage>;
  readonly attachedBeforeReady: Promise<void>;
}

const workspace = (): { readonly root: string; readonly stateRoot: string } => {
  const root = mkdtempSync(join(tmpdir(), "sup-stack-workspace-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "sup-stack-state-"));
  mkdirSync(join(root, ".supabase"), { recursive: true });
  return { root, stateRoot };
};

const messageFor = (
  roots: { readonly root: string; readonly stateRoot: string },
  overrides: Partial<SupervisorStartMessage> = {},
): SupervisorStartMessage => ({
  type: "start",
  workspacePath: roots.root,
  stackName: "default",
  stateRoot: roots.stateRoot,
  config: {
    cwd: roots.root,
    projectDir: roots.root,
    mode: "native",
    auth: false,
    postgrest: false,
    realtime: false,
    storage: false,
    imgproxy: false,
    localSmtp: false,
    pgmeta: false,
    studio: false,
    analytics: false,
    vector: false,
    pooler: false,
  },
  portIntents: { activeFields: ["apiPort", "dbPort"], document: {} },
  testMode: "bind-all",
  ...overrides,
});

const spawnChild = (
  input: SupervisorStartMessage,
  environment: Readonly<Record<string, string>> = {},
): ChildHandle => {
  const child = fork(childEntryPoint, [], {
    execPath: bunExecutable,
    execArgv: [],
    detached: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, SUPABASE_STACK_RUN_DAEMON: "1", ...environment },
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Uint8Array) => {
    stderr += new TextDecoder().decode(chunk);
  });
  const started = new Promise<SupervisorStartedMessage>((resolve, reject) => {
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (value: unknown) => {
      if (typeof value !== "object" || value === null) return;
      if ("type" in value && value.type === "started" && "endpoint" in value) {
        cleanup();
        resolve(value as SupervisorStartedMessage);
      } else if ("type" in value && value.type === "error") {
        cleanup();
        reject(
          new Error(
            `${"message" in value ? String(value.message) : "supervisor failed"}\n${stderr}`,
          ),
        );
      }
    };
    const onError = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`supervisor exited before ack (${String(code)})\n${stderr}`));
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  const attachedBeforeReady = new Promise<void>((resolve, reject) => {
    const onMessage = (value: unknown) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "test-stage" &&
        "stage" in value &&
        value.stage === "attached-before-ready"
      ) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`supervisor exited before attach wait stage (${String(code)})`));
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  void attachedBeforeReady.catch(() => undefined);
  child.send(input);
  return { child, started, attachedBeforeReady };
};

const kill = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });

const waitForExit = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });

const fetchOwner = async (endpoint: ControlEndpoint): Promise<Record<string, unknown>> => {
  const response = await fetch(`${endpoint.url}/owner`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
};

const remoteStop = (endpoint: ControlEndpoint): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          RemoteStack.layer(endpoint).pipe(Layer.provide(httpTransportClientLayer)),
        );
        yield* Context.get(context, Stack).stop();
      }),
    ),
  );

const remoteInfo = (endpoint: ControlEndpoint): Promise<{ readonly url: string }> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          RemoteStack.layer(endpoint).pipe(Layer.provide(httpTransportClientLayer)),
        );
        return yield* Context.get(context, Stack).getInfo();
      }),
    ),
  );

const updateLaunch = async (
  endpoint: ControlEndpoint,
  launch: {
    readonly mode: "native" | "auto" | "docker";
    readonly versions: Record<string, string>;
  },
): Promise<void> => {
  const response = await fetch(`${endpoint.url}/managed/launch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(launch),
  });
  expect(response.status).toBe(200);
  await response.json();
};

const canConnect = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });

const canBind = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });

const listenStartingOwner = async (
  endpoint: ControlEndpoint,
  ownershipId: string,
): Promise<ReturnType<typeof createHttpServer>> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const server = createHttpServer((request, response) => {
      if (request.method === "GET" && request.url === "/owner") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            protocolVersion: 1,
            ownershipId,
            state: "starting",
            ready: false,
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint.port, endpoint.hostname, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server;
    } catch {
      server.close();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out binding fake owner at ${endpoint.url}`);
};

const cleanupRoots = (roots: { readonly root: string; readonly stateRoot: string }): void => {
  rmSync(roots.root, { recursive: true, force: true });
  rmSync(roots.stateRoot, { recursive: true, force: true });
};

const readStackDocument = (roots: {
  readonly stateRoot: string;
}):
  | {
      readonly id: string;
      readonly lifecycle: string;
      readonly ports: ReadonlyArray<{ port: number }>;
      readonly launch?: { readonly mode: string; readonly versions: Record<string, string> };
    }
  | undefined => {
  const stacksRoot = join(roots.stateRoot, "stacks");
  if (!existsSync(stacksRoot)) return undefined;
  for (const id of readdirSync(stacksRoot)) {
    const path = managedStackDocumentPath(roots.stateRoot, id);
    if (!existsSync(path)) continue;
    return JSON.parse(readFileSync(path, "utf8")) as {
      readonly id: string;
      readonly lifecycle: string;
      readonly ports: ReadonlyArray<{ port: number }>;
    };
  }
  return undefined;
};

const waitForStackDocument = async (
  roots: { readonly stateRoot: string },
  lifecycle: string,
): Promise<{
  readonly id: string;
  readonly lifecycle: string;
  readonly ports: ReadonlyArray<{ port: number }>;
}> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const document = readStackDocument(roots);
    if (document?.lifecycle === lifecycle) return document;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for stack document lifecycle ${lifecycle}`);
};

describe("detached supervisor child journeys", () => {
  test("rejects an invalid stack name before forking a supervisor", async () => {
    const roots = workspace();
    try {
      const exit = await Effect.runPromiseExit(
        managedDaemonLayer(messageFor(roots, { stackName: "bad\nname" }), childEntryPoint).pipe(
          Effect.provide(httpTransportClientLayer),
        ),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "InvalidManagedStackNameError",
        });
      }
    } finally {
      cleanupRoots(roots);
    }
  });

  test("keeps managed documents, runtime metadata, and persistent data roots separate", async () => {
    const roots = workspace();
    const stackId = "e".repeat(64);
    const paths = managedStackPaths(roots.stateRoot, stackId);
    try {
      const resolved = await resolveConfig(
        {
          projectDir: roots.root,
          mode: "native",
          auth: false,
          postgrest: false,
          realtime: false,
          storage: false,
          imgproxy: false,
          pgmeta: false,
          studio: false,
          analytics: false,
          vector: false,
          pooler: false,
        },
        {
          stackRoot: paths.root,
          runtimeRoot: paths.runtime,
          portAllocator: () => Effect.succeed({ apiPort: 55001, dbPort: 55002 }),
        },
      );
      expect(managedStackDocumentPath(roots.stateRoot, stackId)).toBe(
        join(paths.root, "stack.json"),
      );
      expect(resolved.postgres.dataDir.startsWith(join(paths.root, "data"))).toBe(true);
    } finally {
      cleanupRoots(roots);
    }
  });

  test("starts one child, publishes owner, and binds every allocated port", async () => {
    const roots = workspace();
    const child = spawnChild(messageFor(roots));
    try {
      const started = await child.started;
      const owner = await fetchOwner(started.endpoint);
      expect(owner).toMatchObject({ state: "running", ready: true });
      const status = await fetch(`${started.endpoint.url}/status`);
      expect(status.status).toBe(200);
      const document = JSON.parse(
        readFileSync(
          join(roots.stateRoot, "stacks", `${String(owner.ownershipId)}`, "stack.json"),
          "utf8",
        ),
      ) as { lifecycle: string; ports: ReadonlyArray<{ port: number }> };
      expect(document.lifecycle).toBe("running");
      expect(document.ports.length).toBeGreaterThan(0);
      expect(existsSync(join(roots.stateRoot, "stacks", "default", "stack.json"))).toBe(false);
      for (const assignment of document.ports) expect(await canConnect(assignment.port)).toBe(true);
      await remoteStop(started.endpoint);
      await waitForExit(child.child);
    } finally {
      if (child.child.exitCode === null) await kill(child.child);
      cleanupRoots(roots);
    }
  });

  test("publishes stopping before a slow owner shutdown can finish", async () => {
    const roots = workspace();
    const child = spawnChild(messageFor(roots, { testMode: "hold-stop" }));
    try {
      const started = await child.started;
      expect(await fetchOwner(started.endpoint)).toMatchObject({ state: "running", ready: true });
      void fetch(`${started.endpoint.url}/stop`, { method: "POST" }).catch(() => undefined);
      const deadline = Date.now() + 2_000;
      let stopping = false;
      while (Date.now() < deadline) {
        if ((await fetchOwner(started.endpoint).catch(() => undefined))?.state === "stopping") {
          stopping = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(stopping).toBe(true);
    } finally {
      if (child.child.exitCode === null) await kill(child.child);
      cleanupRoots(roots);
    }
  });

  test("stops a blocked starting owner through its control endpoint", async () => {
    const roots = workspace();
    const child = spawnChild(messageFor(roots, { testMode: "hold-start" }));
    void child.started.catch(() => undefined);
    try {
      const document = await waitForStackDocument(roots, "starting");
      const endpoint = await Effect.runPromise(controlEndpoint(document.id));
      expect(await fetchOwner(endpoint)).toMatchObject({ state: "starting", ready: false });
      const response = await fetch(`${endpoint.url}/stop`, { method: "POST" });
      expect(response.status).toBe(202);
      await Promise.race([
        waitForExit(child.child),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("owner did not stop")), 2_000),
        ),
      ]);
      const stopped = await waitForStackDocument(roots, "stopped");
      expect(stopped.lifecycle).toBe("stopped");
    } finally {
      if (child.child.exitCode === null) await kill(child.child);
      cleanupRoots(roots);
    }
  });

  test("attaches a second child as RemoteStack while the owner remains live", async () => {
    const roots = workspace();
    const input = messageFor(roots);
    const owner = spawnChild(input);
    const contender = spawnChild(input);
    try {
      const [first, second] = await Promise.all([owner.started, contender.started]);
      const responses = [first, second];
      expect(responses.filter((response) => response.attached === true)).toHaveLength(1);
      expect(responses.filter((response) => response.attached !== true)).toHaveLength(1);
      const started = responses.find((response) => response.attached !== true);
      const attached = responses.find((response) => response.attached === true);
      if (started === undefined || attached === undefined)
        throw new Error("missing child response");
      const status = await fetchOwner(started.endpoint);
      expect(status).toMatchObject({ state: "running" });
      await remoteStop(attached.endpoint);
      await Promise.all([waitForExit(owner.child), waitForExit(contender.child)]);
    } finally {
      if (owner.child.exitCode === null) await kill(owner.child);
      if (contender.child.exitCode === null) await kill(contender.child);
      cleanupRoots(roots);
    }
  });

  test("reacquires and restarts after an attached owner dies during readiness", async () => {
    const roots = workspace();
    const input = messageFor(roots, { testMode: "hold-start" });
    const owner = spawnChild(input);
    void owner.started.catch(() => undefined);
    let contender: ChildHandle | undefined;
    try {
      const document = await waitForStackDocument(roots, "starting");
      const restartedEndpoint = await Effect.runPromise(controlEndpoint(document.id));
      expect(await fetchOwner(restartedEndpoint)).toMatchObject({
        state: "starting",
        ready: false,
      });

      contender = spawnChild(input);
      void contender.started.catch(() => undefined);
      await contender.attachedBeforeReady;

      await kill(owner.child);
      await expect(owner.started).rejects.toThrow();
      const deadline = Date.now() + 3_000;
      let restarted = false;
      while (Date.now() < deadline) {
        if ((await fetchOwner(restartedEndpoint).catch(() => undefined))?.state === "starting") {
          restarted = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(restarted).toBe(true);
    } finally {
      if (owner.child.exitCode === null) await kill(owner.child);
      if (contender?.child.exitCode === null) await kill(contender.child);
      cleanupRoots(roots);
    }
  });

  test("bounds attached-owner recovery to one startup deadline", async () => {
    const roots = workspace();
    const input = messageFor(roots, { testMode: "hold-start" });
    const environment = { SUPABASE_STACK_TEST_STARTUP_TIMEOUT_MS: "400" };
    const owner = spawnChild(input, environment);
    void owner.started.catch(() => undefined);
    let contender: ChildHandle | undefined;
    let fakeOwner: ReturnType<typeof createHttpServer> | undefined;
    try {
      const document = await waitForStackDocument(roots, "starting");
      const endpoint = await Effect.runPromise(controlEndpoint(document.id));
      contender = spawnChild(input, environment);
      void contender.started.catch(() => undefined);
      await contender.attachedBeforeReady;

      await kill(owner.child);
      fakeOwner = await listenStartingOwner(endpoint, document.id);
      const resolutionStarted = Date.now();
      const result = await Promise.race([
        contender.started.then(
          () => ({ _tag: "started" as const }),
          (error: unknown) => ({ _tag: "error" as const, error }),
        ),
        new Promise<{ readonly _tag: "timeout" }>((resolve) =>
          setTimeout(() => resolve({ _tag: "timeout" }), 1_200),
        ),
      ]);
      expect(result._tag).toBe("error");
      if (result._tag === "error") {
        expect(result.error).toMatchObject({
          message: expect.stringContaining("Timed out resolving attached supervisor owner"),
        });
      }
      expect(Date.now() - resolutionStarted).toBeLessThan(900);
    } finally {
      fakeOwner?.close();
      if (owner.child.exitCode === null) await kill(owner.child);
      if (contender?.child.exitCode === null) await kill(contender.child);
      cleanupRoots(roots);
    }
  });

  test("reallocates after a child is killed during startup", async () => {
    const roots = workspace();
    const input = messageFor(roots, { testMode: "hold-start" });
    const killed = spawnChild(input);
    void killed.started.catch(() => undefined);
    try {
      const document = await waitForStackDocument(roots, "starting");
      const endpoint = await Effect.runPromise(controlEndpoint(document.id));
      expect(await fetchOwner(endpoint).catch(() => undefined)).toMatchObject({
        state: "starting",
      });
      for (const assignment of document.ports) expect(await canBind(assignment.port)).toBe(false);
      await kill(killed.child);
      await expect(killed.started).rejects.toThrow();
      const recovered = spawnChild(messageFor(roots));
      try {
        const started = await recovered.started;
        expect((await fetchOwner(started.endpoint)).state).toBe("running");
        expect(document.lifecycle).toBe("starting");
        await remoteStop(started.endpoint);
        await waitForExit(recovered.child);
      } finally {
        if (recovered.child.exitCode === null) await kill(recovered.child);
      }
    } finally {
      if (killed.child.exitCode === null) await kill(killed.child);
      cleanupRoots(roots);
    }
  });

  test("reattaches from a later process and stops the original child", async () => {
    const roots = workspace();
    const input = messageFor(roots);
    const owner = spawnChild(input);
    let later: ChildHandle | undefined;
    try {
      await owner.started;
      later = spawnChild(input);
      const attached = await later.started;
      expect(attached.attached).toBe(true);
      expect(await remoteInfo(attached.endpoint)).toMatchObject({ url: expect.any(String) });
      await updateLaunch(attached.endpoint, { mode: "auto", versions: { postgres: "17.6.1" } });
      expect(readStackDocument(roots)?.launch).toEqual({
        mode: "auto",
        versions: { postgres: "17.6.1" },
      });
      await remoteStop(attached.endpoint);
      await waitForExit(owner.child);
      await waitForExit(later.child);
      const restarted = spawnChild(input);
      const restartedAck = await restarted.started;
      expect(restartedAck.attached).not.toBe(true);
      await remoteStop(restartedAck.endpoint);
      await waitForExit(restarted.child);
    } finally {
      if (owner.child.exitCode === null) await kill(owner.child);
      if (later !== undefined && later.child.exitCode === null) await kill(later.child);
      cleanupRoots(roots);
    }
  });
});
