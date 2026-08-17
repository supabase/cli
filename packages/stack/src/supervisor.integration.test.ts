import { Context, Effect, Layer } from "effect";
import { fork, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { Stack } from "./Stack.ts";
import { RemoteStack } from "./RemoteStack.ts";
import { httpTransportClientLayer } from "./HttpTransportClient.ts";
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

const spawnChild = (input: SupervisorStartMessage): ChildHandle => {
  const child = fork(childEntryPoint, [], {
    execPath: bunExecutable,
    execArgv: [],
    detached: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, SUPABASE_STACK_RUN_DAEMON: "1" },
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

  test("waits for a starting owner before reporting terminal attach failure", async () => {
    const roots = workspace();
    const input = messageFor(roots, { testMode: "hold-start" });
    const owner = spawnChild(input);
    void owner.started.catch(() => undefined);
    let contender: ChildHandle | undefined;
    try {
      const document = await waitForStackDocument(roots, "starting");
      const endpoint = await Effect.runPromise(controlEndpoint(document.id));
      expect(await fetchOwner(endpoint)).toMatchObject({ state: "starting", ready: false });

      contender = spawnChild(input);
      await contender.attachedBeforeReady;

      await kill(owner.child);
      await expect(owner.started).rejects.toThrow();
      await expect(contender.started).rejects.toThrow();
    } finally {
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
