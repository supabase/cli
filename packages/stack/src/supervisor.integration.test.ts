import { Cause, Context, Effect, Exit, Layer } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { fork, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer } from "node:net";
import {
  cpSync,
  chmodSync,
  existsSync,
  type FSWatcher,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { Stack } from "./Stack.ts";
import { RemoteStack } from "./RemoteStack.ts";
import { httpTransportClientLayer } from "./HttpTransportClient.ts";
import { managedDaemonLayer } from "./supervisor.ts";
import { managedStackDocumentPathEffect, managedStackPathsEffect } from "./managed/paths.ts";
import { resolveConfig as resolveConfigEffect } from "./StackConfigResolver.ts";
import { controlEndpoint, type ControlEndpoint } from "./managed/control.ts";
import { deriveStackId, type EnvironmentIdentity } from "./managed/environment.ts";
import type { SupervisorStartMessage, SupervisorStartedMessage } from "./supervisor.ts";
import { git } from "../tests/helpers/git-workspace.ts";

const childEntryPoint = fileURLToPath(
  new URL("../tests/helpers/supervisor-child.ts", import.meta.url),
);
const errorChildEntryPoint = fileURLToPath(
  new URL("../tests/helpers/supervisor-error-child.ts", import.meta.url),
);
const bunExecutable = process.env["BUN_EXECUTABLE"] ?? "bun";
const FILE_WAIT_TIMEOUT_MS = 30_000;

const resolveConfig = (...args: Parameters<typeof resolveConfigEffect>) =>
  Effect.runPromise(resolveConfigEffect(...args).pipe(Effect.provide(NodeFileSystem.layer)));

type TestMode = "bind-all" | "fail-after-bind" | "hold-reservations" | "hold-start" | "hold-stop";

interface ChildHandle {
  readonly child: ChildProcess;
  readonly started: Promise<SupervisorStartedMessage>;
  readonly attachedBeforeReady: Promise<void>;
  readonly managedStarted: Promise<void>;
}

const workspace = async (): Promise<{
  readonly root: string;
  readonly stateRoot: string;
  readonly stackId: string;
}> => {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const root = mkdtempSync(join(tmpdir(), "sup-stack-workspace-"));
    const stateRoot = mkdtempSync(join(tmpdir(), "sup-stack-state-"));
    const identity: EnvironmentIdentity = {
      workspaceId: randomUUID(),
      checkoutId: randomUUID(),
      contextId: randomUUID(),
      localProjectKey: ".",
    };
    const stackId = deriveStackId(identity, "default");
    const endpoint = await Effect.runPromise(controlEndpoint(stackId));
    if (!(await canBind(endpoint.port))) {
      rmSync(root, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
      continue;
    }
    mkdirSync(join(root, ".supabase"), { recursive: true });
    writeFileSync(
      join(root, ".supabase", "identity.json"),
      `${JSON.stringify(
        {
          version: 1,
          workspaceId: identity.workspaceId,
          checkoutId: identity.checkoutId,
          contextId: identity.contextId,
        },
        null,
        2,
      )}\n`,
    );
    return { root, stateRoot, stackId };
  }
  throw new Error("Unable to allocate a free supervisor control endpoint after 32 attempts");
};

/**
 * Watches a directory, re-arming on ENOENT watcher errors: the runtime's
 * directory watcher can report ENOENT when a watched entry (for example an
 * atomic-write temp file) vanishes mid-scan. Callers keep their own timeout
 * as the guard. Returns a close function.
 */
const watchDirectoryWithRetry = (
  directory: string,
  onEvent: () => void,
  onError: (cause: unknown) => void,
): (() => void) => {
  let watcher: FSWatcher | undefined;
  let closed = false;
  const arm = () => {
    if (closed) return;
    try {
      watcher = watch(directory, () => onEvent());
      watcher.once("error", (cause) => {
        watcher?.close();
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
          arm();
          onEvent();
          return;
        }
        onError(cause);
      });
    } catch (cause) {
      onError(cause);
    }
  };
  arm();
  return () => {
    closed = true;
    watcher?.close();
  };
};

const waitForFile = (path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (existsSync(path)) {
      resolve();
      return;
    }
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stopWatching: (() => void) | undefined;
    const settle = (continuation: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      stopWatching?.();
      continuation();
    };
    stopWatching = watchDirectoryWithRetry(
      dirname(path),
      () => {
        if (existsSync(path)) settle(resolve);
      },
      (cause) => settle(() => reject(cause instanceof Error ? cause : new Error(String(cause)))),
    );
    timeout = setTimeout(
      () => settle(() => reject(new Error(`timed out waiting for file ${path}`))),
      FILE_WAIT_TIMEOUT_MS,
    );
    if (existsSync(path)) {
      settle(resolve);
    }
  });

const messageFor = (
  roots: {
    readonly root: string;
    readonly stateRoot: string;
    readonly stackId: string;
  },
  overrides: Partial<SupervisorStartMessage> = {},
): SupervisorStartMessage => ({
  type: "start",
  stackId: roots.stackId,
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
  portIntents: {
    activeFields: ["apiPort", "dbPort"],
    document: {},
  },
  ...overrides,
});

const spawnChild = (
  input: SupervisorStartMessage,
  options: {
    readonly testMode?: TestMode;
    readonly platform?: "node" | "bun";
    readonly environment?: Readonly<Record<string, string>>;
  } = {},
): ChildHandle => {
  const child = fork(childEntryPoint, [], {
    execPath: bunExecutable,
    execArgv: [],
    detached: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      SUPABASE_STACK_RUN_DAEMON: "1",
      ...(options.testMode === undefined
        ? {}
        : { SUPABASE_STACK_TEST_RUNTIME_MODE: options.testMode }),
      ...(options.platform === undefined ? {} : { SUPABASE_STACK_TEST_PLATFORM: options.platform }),
      ...options.environment,
    },
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
  const waitForStage = (stage: "attached-before-ready" | "managed-started") =>
    new Promise<void>((resolve, reject) => {
      const onMessage = (value: unknown) => {
        if (
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          value.type === "test-stage" &&
          "stage" in value &&
          value.stage === stage
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
        reject(new Error(`supervisor exited before ${stage} stage (${String(code)})`));
      };
      child.on("message", onMessage);
      child.once("error", onError);
      child.once("exit", onExit);
    });
  const attachedBeforeReady = waitForStage("attached-before-ready");
  const managedStarted = waitForStage("managed-started");
  void started.catch(() => undefined);
  void attachedBeforeReady.catch(() => undefined);
  void managedStarted.catch(() => undefined);
  child.send(input);
  return { child, started, attachedBeforeReady, managedStarted };
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

const bindFakeOwner = async (
  endpoint: ControlEndpoint,
  makeServer: () => ReturnType<typeof createHttpServer>,
): Promise<ReturnType<typeof createHttpServer>> => {
  const server = makeServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error) => {
      server.off("listening", onListening);
      reject(new Error(`unable to bind fake owner at ${endpoint.url}: ${cause.message}`));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint.port, endpoint.hostname);
  });
  return server;
};

const listenStartingOwner = (
  endpoint: ControlEndpoint,
  ownershipId: string,
): Promise<ReturnType<typeof createHttpServer>> =>
  bindFakeOwner(endpoint, () =>
    createHttpServer((request, response) => {
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
    }),
  );

const listenOwnerSequence = (
  endpoint: ControlEndpoint,
  ownershipId: string,
  states: ReadonlyArray<"starting" | "stopping">,
  onRead: (state: "starting" | "stopping") => void = () => undefined,
  closeAfterSequence = true,
): Promise<ReturnType<typeof createHttpServer>> =>
  bindFakeOwner(endpoint, () => {
    let reads = 0;
    const server = createHttpServer((request, response) => {
      if (request.method !== "GET" || request.url !== "/owner") {
        response.writeHead(404);
        response.end();
        return;
      }
      const state = states[Math.min(reads, states.length - 1)] ?? "starting";
      reads += 1;
      onRead(state);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          protocolVersion: 1,
          ownershipId,
          state,
          ready: false,
        }),
        () => {
          if (closeAfterSequence && reads >= states.length) server.close();
        },
      );
    });
    return server;
  });

const listenStoppingOwner = async (
  endpoint: ControlEndpoint,
  ownershipId: string,
): Promise<{
  readonly server: ReturnType<typeof createHttpServer>;
  readonly release: () => void;
}> => {
  const server = await listenOwnerSequence(
    endpoint,
    ownershipId,
    ["stopping"],
    () => undefined,
    false,
  );
  let released = false;
  return {
    server,
    release: () => {
      if (released) return;
      released = true;
      server.close();
    },
  };
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
      readonly ports: ReadonlyArray<{ key: string; port: number }>;
      readonly launch?: {
        readonly mode: string;
        readonly containerRuntime?: string;
        readonly versions: Record<string, string>;
      };
    }
  | undefined => {
  const stacksRoot = join(roots.stateRoot, "stacks");
  if (!existsSync(stacksRoot)) return undefined;
  for (const id of readdirSync(stacksRoot)) {
    const path = Effect.runSync(managedStackDocumentPathEffect(roots.stateRoot, id));
    if (!existsSync(path)) continue;
    return JSON.parse(readFileSync(path, "utf8")) as {
      readonly id: string;
      readonly lifecycle: string;
      readonly ports: ReadonlyArray<{ key: string; port: number }>;
    };
  }
  return undefined;
};

type StackDocument = {
  readonly id: string;
  readonly lifecycle: string;
  readonly ports: ReadonlyArray<{ port: number }>;
  readonly launch?: { readonly mode: string; readonly versions: Record<string, string> };
};

const waitForStackDocument = async (
  roots: { readonly stateRoot: string; readonly stackId: string },
  lifecycle: string,
): Promise<StackDocument> => {
  const documentPath = Effect.runSync(
    managedStackDocumentPathEffect(roots.stateRoot, roots.stackId),
  );
  const stackDirectory = dirname(documentPath);
  await waitForFile(dirname(stackDirectory));
  await waitForFile(stackDirectory);
  await waitForFile(documentPath);
  const readDocument = (): StackDocument | undefined => {
    try {
      return JSON.parse(readFileSync(documentPath, "utf8")) as StackDocument;
    } catch {
      return undefined;
    }
  };
  const existing = readDocument();
  if (existing?.lifecycle === lifecycle) return existing;

  return new Promise((resolve, reject) => {
    let stopWatching: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (continuation: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      stopWatching?.();
      continuation();
    };
    const check = () => {
      const document = readDocument();
      if (document?.lifecycle === lifecycle) {
        settle(() => resolve(document));
      }
    };
    const fail = (cause: unknown) =>
      settle(() => reject(cause instanceof Error ? cause : new Error(String(cause))));
    stopWatching = watchDirectoryWithRetry(stackDirectory, check, fail);
    timeout = setTimeout(
      () => fail(new Error(`timed out waiting for stack document lifecycle ${lifecycle}`)),
      FILE_WAIT_TIMEOUT_MS,
    );
    check();
  });
};

describe("detached supervisor child journeys", () => {
  test("rejects an invalid stack name before forking a supervisor", async () => {
    const roots = await workspace();
    try {
      const exit = await Effect.runPromiseExit(
        managedDaemonLayer(messageFor(roots, { stackName: "bad\nname" }), childEntryPoint).pipe(
          Effect.provide(httpTransportClientLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "InvalidManagedStackNameError",
        });
      }
    } finally {
      cleanupRoots(roots);
    }
  });

  test("preserves a supervisor startup error reported by the child", async () => {
    const roots = await workspace();
    try {
      const exit = await Effect.runPromiseExit(
        managedDaemonLayer(messageFor(roots), errorChildEntryPoint).pipe(
          Effect.provide(httpTransportClientLayer),
          Effect.provide(NodeFileSystem.layer),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SupervisorStartError",
          message: "Supervisor test runtime failed after binding",
        });
      }
    } finally {
      cleanupRoots(roots);
    }
  });

  test("keeps managed documents, runtime metadata, and persistent data roots separate", async () => {
    const roots = await workspace();
    const stackId = "e".repeat(64);
    const paths = Effect.runSync(managedStackPathsEffect(roots.stateRoot, stackId));
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
          ports: { apiPort: 55001, dbPort: 55002 },
        },
      );
      expect(Effect.runSync(managedStackDocumentPathEffect(roots.stateRoot, stackId))).toBe(
        join(paths.root, "stack.json"),
      );
      expect(resolved.postgres.dataDir.startsWith(join(paths.root, "data"))).toBe(true);
    } finally {
      cleanupRoots(roots);
    }
  });

  test("starts one child, publishes owner, and binds every allocated port", async () => {
    const roots = await workspace();
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

  test("starts an omitted-mode stack from one detected runtime selection", async () => {
    const roots = await workspace();
    const binDir = mkdtempSync(join(tmpdir(), "sup-stack-runtime-"));
    const docker = join(binDir, "docker");
    writeFileSync(docker, "#!/bin/sh\nexit 0\n");
    chmodSync(docker, 0o755);
    const base = messageFor(roots);
    const { mode: _mode, ...config } = base.config;
    const child = spawnChild(
      messageFor(roots, {
        config: { ...config, edgeRuntime: {} },
      }),
      { environment: { PATH: `${binDir}:${process.env["PATH"] ?? ""}` } },
    );
    try {
      const started = await child.started;
      const document = readStackDocument(roots);
      expect(document?.launch).toMatchObject({
        mode: "docker",
        containerRuntime: "docker",
      });
      expect(document?.ports.map(({ key }) => key)).toContain("edge_runtime.inspector_port");
      await remoteStop(started.endpoint);
      await waitForExit(child.child);
    } finally {
      if (child.child.exitCode === null) await kill(child.child);
      cleanupRoots(roots);
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("rejects an explicit mode change before attaching to a running owner", async () => {
    const roots = await workspace();
    const binDir = mkdtempSync(join(tmpdir(), "sup-stack-mode-attach-"));
    const docker = join(binDir, "docker");
    writeFileSync(docker, "#!/bin/sh\nexit 0\n");
    chmodSync(docker, 0o755);
    const nativeInput = messageFor(roots);
    const dockerInput = messageFor(roots, {
      config: { ...nativeInput.config, mode: "docker" },
    });
    const environment = { PATH: `${binDir}:${process.env["PATH"] ?? ""}` };
    const owner = spawnChild(dockerInput, { environment });
    let contender: ChildHandle | undefined;
    let sameMode: ChildHandle | undefined;
    try {
      const started = await owner.started;
      contender = spawnChild(nativeInput, { environment });
      await expect(contender.started).rejects.toThrow(
        "Stack runtime is already docker; requested native",
      );
      await waitForExit(contender.child);

      sameMode = spawnChild(dockerInput, { environment });
      const attached = await sameMode.started;
      expect(attached.attached).toBe(true);
      await remoteStop(started.endpoint);
      await Promise.all([waitForExit(owner.child), waitForExit(sameMode.child)]);
    } finally {
      if (owner.child.exitCode === null) await kill(owner.child);
      if (contender?.child.exitCode === null) await kill(contender.child);
      if (sameMode?.child.exitCode === null) await kill(sameMode.child);
      cleanupRoots(roots);
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("reuses the persisted runtime instead of selecting a different one on restart", async () => {
    const roots = await workspace();
    const binDir = mkdtempSync(join(tmpdir(), "sup-stack-sticky-runtime-"));
    const docker = join(binDir, "docker");
    const podman = join(binDir, "podman");
    writeFileSync(docker, "#!/bin/sh\nexit 0\n");
    writeFileSync(podman, "#!/bin/sh\nexit 1\n");
    chmodSync(docker, 0o755);
    chmodSync(podman, 0o755);
    const base = messageFor(roots);
    const { mode: _mode, ...config } = base.config;
    const input = messageFor(roots, { config });
    const environment = { PATH: `${binDir}:${process.env["PATH"] ?? ""}` };
    const initial = spawnChild(input, { environment });
    let restarted: ChildHandle | undefined;
    try {
      const started = await initial.started;
      await remoteStop(started.endpoint);
      await waitForExit(initial.child);

      writeFileSync(docker, "#!/bin/sh\nexit 1\n");
      writeFileSync(podman, "#!/bin/sh\nexit 0\n");
      restarted = spawnChild(input, { environment });

      await expect(restarted.started).rejects.toThrow(
        "Docker mode requires a usable docker runtime",
      );
      expect(readStackDocument(roots)?.launch).toMatchObject({
        mode: "docker",
        containerRuntime: "docker",
      });
    } finally {
      if (initial.child.exitCode === null) await kill(initial.child);
      if (restarted?.child.exitCode === null) await kill(restarted.child);
      cleanupRoots(roots);
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("publishes stopping before a slow owner shutdown can finish", async () => {
    const roots = await workspace();
    const stopBegan = join(roots.root, "stop-began");
    const child = spawnChild(messageFor(roots), {
      testMode: "hold-stop",
      environment: { SUPABASE_STACK_TEST_STOP_BEGAN_FILE: stopBegan },
    });
    try {
      const started = await child.started;
      expect(await fetchOwner(started.endpoint)).toMatchObject({ state: "running", ready: true });
      void fetch(`${started.endpoint.url}/stop`, { method: "POST" }).catch(() => undefined);
      await waitForFile(stopBegan);
      expect(await fetchOwner(started.endpoint)).toMatchObject({ state: "stopping" });
    } finally {
      if (child.child.exitCode === null) await kill(child.child);
      cleanupRoots(roots);
    }
  });

  test("Bun routes a ready-owner stop through the daemon shutdown transaction", async () => {
    const roots = await workspace();
    const stopBegan = join(roots.root, "stop-began");
    const child = spawnChild(messageFor(roots), {
      testMode: "hold-stop",
      platform: "bun",
      environment: { SUPABASE_STACK_TEST_STOP_BEGAN_FILE: stopBegan },
    });
    try {
      const started = await child.started;
      let responseSettled = false;
      const stopResult = fetch(`${started.endpoint.url}/stop`, { method: "POST" })
        .then((response) => {
          responseSettled = true;
          return response.status;
        })
        .catch(() => {
          responseSettled = true;
          return undefined;
        });
      await waitForFile(stopBegan);
      expect(await fetchOwner(started.endpoint)).toMatchObject({ state: "stopping" });
      expect(responseSettled).toBe(false);
      await kill(child.child);
      await stopResult;
    } finally {
      if (child.child.exitCode === null) await kill(child.child);
      cleanupRoots(roots);
    }
  });

  test("starts after an owner finishes stopping", async () => {
    const roots = await workspace();
    const releaseFile = join(roots.root, "release-stop");
    const stopBegan = join(roots.root, "stop-began");
    const input = messageFor(roots);
    const owner = spawnChild(input, {
      testMode: "hold-stop",
      environment: {
        SUPABASE_STACK_TEST_STOP_RELEASE_FILE: releaseFile,
        SUPABASE_STACK_TEST_STOP_BEGAN_FILE: stopBegan,
      },
    });
    let contender: ChildHandle | undefined;
    try {
      const started = await owner.started;
      const stop = fetch(`${started.endpoint.url}/stop`, { method: "POST" }).catch(() => undefined);
      await waitForFile(stopBegan);
      expect(await fetchOwner(started.endpoint)).toMatchObject({ state: "stopping" });

      contender = spawnChild(input);
      await contender.attachedBeforeReady;
      writeFileSync(releaseFile, "release");
      const restarted = await contender.started;
      expect(restarted.attached).not.toBe(true);
      expect(await fetchOwner(restarted.endpoint)).toMatchObject({ state: "running", ready: true });
      await stop;
      await remoteStop(restarted.endpoint);
      await waitForExit(contender.child);
    } finally {
      if (owner.child.exitCode === null) await kill(owner.child);
      if (contender?.child.exitCode === null) await kill(contender.child);
      cleanupRoots(roots);
    }
  });

  test("accepts stop while workspace discovery is still blocked", async () => {
    const roots = await workspace();
    const ensureReady = join(roots.root, "ensure-ready");
    const ensureRelease = join(roots.root, "ensure-release");
    const child = spawnChild(messageFor(roots), {
      environment: {
        SUPABASE_STACK_TEST_ENSURE_READY_FILE: ensureReady,
        SUPABASE_STACK_TEST_ENSURE_RELEASE_FILE: ensureRelease,
      },
    });
    void child.started.catch(() => undefined);
    try {
      await waitForFile(ensureReady);
      expect(existsSync(ensureReady)).toBe(true);
      const endpoint = await Effect.runPromise(controlEndpoint(roots.stackId));
      const response = await fetch(`${endpoint.url}/stop`, { method: "POST" });
      expect(response.status).toBe(202);
      writeFileSync(ensureRelease, "release");
      await expect(child.started).rejects.toThrow("Stack was stopped during startup");
      await waitForExit(child.child);
      expect(readStackDocument(roots)).toBeUndefined();
    } finally {
      if (child.child.exitCode === null) await kill(child.child);
      cleanupRoots(roots);
    }
  });

  test("rejects an attached contender whose copied workspace collides after owner validation", async () => {
    const roots = await workspace();
    const copied = `${roots.root}-copy`;
    const ensureReady = join(roots.root, "ensure-ready");
    const ensureRelease = join(roots.root, "ensure-release");
    const owner = spawnChild(messageFor(roots), {
      environment: {
        SUPABASE_STACK_TEST_ENSURE_READY_FILE: ensureReady,
        SUPABASE_STACK_TEST_ENSURE_RELEASE_FILE: ensureRelease,
      },
    });
    let contender: ChildHandle | undefined;
    try {
      await waitForFile(ensureReady);
      expect(existsSync(ensureReady)).toBe(true);

      cpSync(roots.root, copied, { recursive: true });
      contender = spawnChild(messageFor(roots, { workspacePath: copied }));
      await contender.attachedBeforeReady;

      writeFileSync(ensureRelease, "release");
      const started = await owner.started;
      expect(started.attached).not.toBe(true);
      await expect(contender.started).rejects.toThrow(
        /ordinary workspace identity.*\.supabase\/identity\.json/,
      );
      await remoteStop(started.endpoint);
      await waitForExit(owner.child);
    } finally {
      if (owner.child.exitCode === null) await kill(owner.child);
      if (contender?.child.exitCode === null) await kill(contender.child);
      rmSync(copied, { recursive: true, force: true });
      cleanupRoots(roots);
    }
  });

  test("rejects a copied contender after dead-owner takeover before Docker cleanup", async () => {
    const roots = await workspace();
    const copied = `${roots.root}-copy`;
    const dockerBin = join(roots.root, "fake-docker-bin");
    const dockerSentinel = join(roots.root, "docker-called");
    mkdirSync(dockerBin);
    const docker = join(dockerBin, "docker");
    writeFileSync(docker, `#!/bin/sh\nprintf called >> ${dockerSentinel}\n`);
    chmodSync(docker, 0o755);
    const owner = spawnChild(messageFor(roots), { testMode: "hold-start" });
    void owner.started.catch(() => undefined);
    let contender: ChildHandle | undefined;
    let fakeOwner: ReturnType<typeof createHttpServer> | undefined;
    let releaseFakeOwner: (() => void) | undefined;
    try {
      const starting = await waitForStackDocument(roots, "starting");
      const endpoint = await Effect.runPromise(controlEndpoint(starting.id));
      const stop = await fetch(`${endpoint.url}/stop`, { method: "POST" });
      expect(stop.status).toBe(202);
      await waitForExit(owner.child);
      expect((await waitForStackDocument(roots, "stopped")).lifecycle).toBe("stopped");

      cpSync(roots.root, copied, { recursive: true });
      const originalGit = join(roots.root, ".git");
      git(roots.root, "init", "-q", "-b", "main");
      git(roots.root, "commit", "-q", "--allow-empty", "-m", "init");
      const stoppingOwner = await listenStoppingOwner(endpoint, starting.id);
      fakeOwner = stoppingOwner.server;
      releaseFakeOwner = stoppingOwner.release;
      contender = spawnChild(messageFor(roots, { workspacePath: copied }), {
        environment: { PATH: `${dockerBin}:${process.env.PATH ?? ""}` },
      });
      await contender.attachedBeforeReady;

      rmSync(originalGit, { recursive: true, force: true });
      const documentPath = Effect.runSync(
        managedStackDocumentPathEffect(roots.stateRoot, starting.id),
      );
      const document = JSON.parse(readFileSync(documentPath, "utf8")) as Record<string, unknown>;
      writeFileSync(documentPath, JSON.stringify({ ...document, lifecycle: "running" }));
      releaseFakeOwner?.();
      releaseFakeOwner = undefined;
      fakeOwner = undefined;

      await expect(contender.started).rejects.toThrow(
        /ordinary workspace identity.*\.supabase\/identity\.json/,
      );
      expect(existsSync(dockerSentinel)).toBe(false);
    } finally {
      fakeOwner?.close();
      if (owner.child.exitCode === null) await kill(owner.child);
      if (contender?.child.exitCode === null) await kill(contender.child);
      rmSync(copied, { recursive: true, force: true });
      cleanupRoots(roots);
    }
  });

  test("does not mark an existing stopped document failed when discovery fails after control bind", async () => {
    const roots = await workspace();
    const initial = spawnChild(messageFor(roots));
    try {
      const started = await initial.started;
      await remoteStop(started.endpoint);
      await waitForExit(initial.child);
      expect((await waitForStackDocument(roots, "stopped")).lifecycle).toBe("stopped");

      writeFileSync(join(roots.root, ".supabase", "identity.json"), "not-json\n");
      const failed = spawnChild(messageFor(roots));
      try {
        await expect(failed.started).rejects.toThrow("ordinary workspace identity");
        await waitForExit(failed.child);
        expect(readStackDocument(roots)?.lifecycle).toBe("stopped");
      } finally {
        if (failed.child.exitCode === null) await kill(failed.child);
      }
    } finally {
      if (initial.child.exitCode === null) await kill(initial.child);
      cleanupRoots(roots);
    }
  });

  test("stops a blocked starting owner through its control endpoint", async () => {
    const roots = await workspace();
    const child = spawnChild(messageFor(roots), { testMode: "hold-start" });
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
          setTimeout(
            () => reject(new Error(`owner did not stop within ${FILE_WAIT_TIMEOUT_MS}ms`)),
            FILE_WAIT_TIMEOUT_MS,
          ),
        ),
      ]);
      const stopped = await waitForStackDocument(roots, "stopped");
      expect(stopped.lifecycle).toBe("stopped");
    } finally {
      if (child.child.exitCode === null) await kill(child.child);
      cleanupRoots(roots);
    }
  });

  test("does not restart a stopped owner after attached takeover", async () => {
    const roots = await workspace();
    const input = messageFor(roots);
    const owner = spawnChild(input, { testMode: "hold-start" });
    void owner.started.catch(() => undefined);
    let contender: ChildHandle | undefined;
    let fakeOwner: ReturnType<typeof createHttpServer> | undefined;
    const observedStates: Array<"starting" | "stopping"> = [];
    try {
      const document = await waitForStackDocument(roots, "starting");
      const endpoint = await Effect.runPromise(controlEndpoint(document.id));
      expect(await fetchOwner(endpoint)).toMatchObject({ state: "starting", ready: false });
      const stopResponse = await fetch(`${endpoint.url}/stop`, { method: "POST" });
      expect(stopResponse.status).toBe(202);
      await waitForExit(owner.child);
      expect((await waitForStackDocument(roots, "stopped")).lifecycle).toBe("stopped");

      fakeOwner = await listenOwnerSequence(
        endpoint,
        document.id,
        ["starting", "starting", "stopping"],
        (state) => observedStates.push(state),
      );
      contender = spawnChild(input);
      await contender.attachedBeforeReady;

      await expect(contender.started).rejects.toMatchObject({
        message: expect.stringContaining("stopped before takeover"),
      });
      expect(observedStates).toEqual(["starting", "starting", "stopping"]);
      expect(readStackDocument(roots)?.lifecycle).toBe("stopped");
    } finally {
      fakeOwner?.close();
      if (owner.child.exitCode === null) await kill(owner.child);
      if (contender?.child.exitCode === null) await kill(contender.child);
      cleanupRoots(roots);
    }
  });

  test("attaches a second child as RemoteStack while the owner remains live", async () => {
    const roots = await workspace();
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
    const roots = await workspace();
    const input = messageFor(roots);
    const owner = spawnChild(input, { testMode: "hold-start" });
    void owner.started.catch(() => undefined);
    let contender: ChildHandle | undefined;
    try {
      const document = await waitForStackDocument(roots, "starting");
      const restartedEndpoint = await Effect.runPromise(controlEndpoint(document.id));
      expect(await fetchOwner(restartedEndpoint)).toMatchObject({
        state: "starting",
        ready: false,
      });

      contender = spawnChild(input, { testMode: "hold-start" });
      void contender.started.catch(() => undefined);
      await contender.attachedBeforeReady;

      await kill(owner.child);
      await expect(owner.started).rejects.toThrow();
      await contender.managedStarted;
      expect(await fetchOwner(restartedEndpoint)).toMatchObject({ state: "starting" });
    } finally {
      if (owner.child.exitCode === null) await kill(owner.child);
      if (contender?.child.exitCode === null) await kill(contender.child);
      cleanupRoots(roots);
    }
  });

  test("restarts after attaching to an owner that is already stopping", async () => {
    const roots = await workspace();
    const input = messageFor(roots);
    const initial = spawnChild(input);
    let contender: ChildHandle | undefined;
    let fakeOwner: ReturnType<typeof createHttpServer> | undefined;
    const observedStates: Array<"starting" | "stopping"> = [];
    try {
      const started = await initial.started;
      await remoteStop(started.endpoint);
      await waitForExit(initial.child);
      const document = await waitForStackDocument(roots, "stopped");
      const endpoint = await Effect.runPromise(controlEndpoint(document.id));
      fakeOwner = await listenOwnerSequence(
        endpoint,
        document.id,
        ["stopping", "stopping"],
        (state) => observedStates.push(state),
      );
      contender = spawnChild(input);
      void contender.started.catch(() => undefined);

      const restarted = await contender.started;
      expect(observedStates).toEqual(["stopping", "stopping"]);
      expect(restarted.attached).not.toBe(true);
      expect(await fetchOwner(restarted.endpoint)).toMatchObject({ state: "running", ready: true });
      await remoteStop(restarted.endpoint);
      await waitForExit(contender.child);
    } finally {
      fakeOwner?.close();
      if (initial.child.exitCode === null) await kill(initial.child);
      if (contender?.child.exitCode === null) await kill(contender.child);
      cleanupRoots(roots);
    }
  });

  test("bounds attached-owner recovery to one startup deadline", { timeout: 30_000 }, async () => {
    const roots = await workspace();
    const input = messageFor(roots);
    const attachedReady = join(roots.root, "attached-before-ready-ready");
    const attachedRelease = join(roots.root, "attached-before-ready-release");
    const owner = spawnChild(input, {
      testMode: "hold-start",
      environment: { SUPABASE_STACK_TEST_STARTUP_TIMEOUT_MS: "400" },
    });
    void owner.started.catch(() => undefined);
    let contender: ChildHandle | undefined;
    let fakeOwner: ReturnType<typeof createHttpServer> | undefined;
    try {
      const document = await waitForStackDocument(roots, "starting");
      const endpoint = await Effect.runPromise(controlEndpoint(document.id));
      contender = spawnChild(input, {
        testMode: "hold-start",
        environment: {
          SUPABASE_STACK_TEST_STARTUP_TIMEOUT_MS: "400",
          SUPABASE_STACK_TEST_ATTACHED_READY_FILE: attachedReady,
          SUPABASE_STACK_TEST_ATTACHED_RELEASE_FILE: attachedRelease,
        },
      });
      void contender.started.catch(() => undefined);
      await contender.attachedBeforeReady;
      await waitForFile(attachedReady);

      await kill(owner.child);
      fakeOwner = await listenStartingOwner(endpoint, document.id);
      writeFileSync(attachedRelease, "release");
      await expect(contender.started).rejects.toMatchObject({
        message: expect.stringContaining("Timed out resolving attached supervisor owner"),
      });
    } finally {
      fakeOwner?.close();
      if (owner.child.exitCode === null) await kill(owner.child);
      if (contender?.child.exitCode === null) await kill(contender.child);
      cleanupRoots(roots);
    }
  });

  test("reallocates after a child is killed during startup", async () => {
    const roots = await workspace();
    const input = messageFor(roots);
    const killed = spawnChild(input, { testMode: "hold-start" });
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
    const roots = await workspace();
    const input = messageFor(roots);
    const owner = spawnChild(input);
    let later: ChildHandle | undefined;
    try {
      await owner.started;
      later = spawnChild(input);
      const attached = await later.started;
      expect(attached.attached).toBe(true);
      expect(await remoteInfo(attached.endpoint)).toMatchObject({ url: expect.any(String) });
      await updateLaunch(attached.endpoint, { versions: { postgres: "17.6.1" } });
      expect(readStackDocument(roots)?.launch).toEqual({
        mode: "native",
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
