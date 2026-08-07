import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ServiceNotFoundError, ServiceReadyError, type LogEntry } from "@supabase/process-compose";
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DaemonServer } from "./DaemonServer.ts";
import { StackBuildError, StackReadinessError } from "./errors.ts";
import type { FunctionsReloadConfig, ResolvedFunctionsBundle } from "./functions.ts";
import { RemoteStack } from "./RemoteStack.ts";
import { Stack, type EdgeRuntimeReloadConfig, type StackInfo } from "./Stack.ts";
import type { ReadyOptions } from "./StackConfig.ts";
import { StackServiceState } from "./StackServiceState.ts";
import { UnixHttpClient, UnixHttpClientError } from "./UnixHttpClient.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const MOCK_INFO: StackInfo = {
  url: "http://127.0.0.1:54321",
  dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  publishableKey: "pk_test",
  secretKey: "sk_test",
  anonJwt: "anon_jwt",
  serviceRoleJwt: "service_role_jwt",
  serviceEndpoints: {},
};

const POSTGRES_STATE = new StackServiceState({
  name: "postgres",
  status: "Running",
  pid: 1234,
  exitCode: null,
  restartCount: 0,
  startedAt: Date.now(),
  error: null,
});

const AUTH_STATE = new StackServiceState({
  name: "auth",
  status: "Healthy",
  pid: 5678,
  exitCode: null,
  restartCount: 0,
  startedAt: Date.now(),
  error: null,
});

const HEALTH_FAILED_STATE = new StackServiceState({
  name: "edge-runtime",
  status: "Failed",
  pid: null,
  exitCode: null,
  restartCount: 2,
  startedAt: Date.now(),
  error: "Health check failed and restart budget was exhausted",
});

const MOCK_STATES: ReadonlyArray<StackServiceState> = [
  POSTGRES_STATE,
  AUTH_STATE,
  HEALTH_FAILED_STATE,
];

const MOCK_LOGS: ReadonlyArray<LogEntry> = [
  { timestamp: 1000, service: "postgres", stream: "stdout", line: "starting" },
  { timestamp: 1001, service: "postgres", stream: "stdout", line: "ready" },
  { timestamp: 1002, service: "auth", stream: "stdout", line: "auth started" },
];

// ---------------------------------------------------------------------------
// Mock Stack (server-side, backing the DaemonServer)
// ---------------------------------------------------------------------------

function mockStack(
  options: {
    readonly startServiceBuildError?: string;
    readonly startServiceReadyError?: string;
    readonly waitReadyBuildError?: string;
    readonly waitReadyTimeoutMs?: number;
    readonly restartServiceReadyError?: string;
  } = {},
) {
  let stopped = false;
  const serviceCalls: string[] = [];
  const functionReloads: FunctionsReloadConfig[] = [];
  const edgeRuntimeReloads: EdgeRuntimeReloadConfig[] = [];
  const readinessCalls: Array<{ readonly target: string; readonly options?: ReadyOptions }> = [];

  const layer = Layer.succeed(Stack, {
    getInfo: () => Effect.succeed(MOCK_INFO),
    start: () => Effect.void,
    stop: () =>
      Effect.sync(() => {
        stopped = true;
      }),
    dispose: () =>
      Effect.sync(() => {
        stopped = true;
      }),
    startService: (name: string) =>
      name === "unknown"
        ? Effect.fail(new ServiceNotFoundError({ name }))
        : options.startServiceBuildError !== undefined
          ? Effect.fail(new StackBuildError({ detail: options.startServiceBuildError }))
          : options.startServiceReadyError !== undefined
            ? Effect.fail(
                new ServiceReadyError({
                  name,
                  reason: options.startServiceReadyError,
                }),
              )
            : Effect.sync(() => {
                serviceCalls.push(`start:${name}`);
              }),
    stopService: (name: string) =>
      name === "unknown"
        ? Effect.fail(new ServiceNotFoundError({ name }))
        : Effect.sync(() => {
            serviceCalls.push(`stop:${name}`);
          }),
    restartService: (name: string) =>
      name === "unknown"
        ? Effect.fail(new ServiceNotFoundError({ name }))
        : options.restartServiceReadyError !== undefined
          ? Effect.fail(
              new ServiceReadyError({
                name,
                reason: options.restartServiceReadyError,
              }),
            )
          : Effect.sync(() => {
              serviceCalls.push(`restart:${name}`);
            }),
    reloadFunctions: (config) =>
      Effect.sync(() => {
        functionReloads.push(config ?? {});
        serviceCalls.push("reload-functions");
      }),
    reloadEdgeRuntime: (config) =>
      Effect.sync(() => {
        edgeRuntimeReloads.push(config);
        serviceCalls.push("reload-edge-runtime");
      }),
    getState: (name: string) => {
      const match = MOCK_STATES.find((s) => s.name === name);
      return match ? Effect.succeed(match) : Effect.fail(new ServiceNotFoundError({ name }));
    },
    getAllStates: () => Effect.succeed(MOCK_STATES),
    stateChanges: (name: string) => {
      const match = MOCK_STATES.find((s) => s.name === name);
      return match
        ? Effect.succeed(Stream.fromIterable([match]))
        : Effect.fail(new ServiceNotFoundError({ name }));
    },
    allStateChanges: () => Stream.fromIterable(MOCK_STATES),
    waitReady: (name: string, readyOptions?: ReadyOptions) => {
      const match = MOCK_STATES.find((s) => s.name === name);
      if (match === undefined) return Effect.fail(new ServiceNotFoundError({ name }));
      if (options.waitReadyBuildError !== undefined) {
        return Effect.fail(new StackBuildError({ detail: options.waitReadyBuildError }));
      }
      if (options.waitReadyTimeoutMs !== undefined) {
        return Effect.fail(
          new StackReadinessError({
            target: name,
            timeoutMs: options.waitReadyTimeoutMs,
            detail: `Timed out waiting for ${name}`,
          }),
        );
      }
      return Effect.sync(() => {
        readinessCalls.push({ target: name, options: readyOptions });
        serviceCalls.push(`ready:${name}`);
      });
    },
    waitAllReady: (readyOptions?: ReadyOptions) =>
      Effect.sync(() => {
        readinessCalls.push({ target: "stack", options: readyOptions });
        serviceCalls.push("ready:all");
      }),
    subscribeLogs: (name: string) =>
      Stream.fromIterable(MOCK_LOGS.filter((l) => l.service === name)),
    subscribeAllLogs: (services?: ReadonlyArray<string>) =>
      Stream.fromIterable(
        services === undefined || services.length === 0
          ? MOCK_LOGS
          : MOCK_LOGS.filter((l) => services.includes(l.service)),
      ),
    logHistory: (name: string, limit?: number) =>
      Effect.succeed(MOCK_LOGS.filter((l) => l.service === name).slice(-(limit ?? 100))),
    logHistoryAll: (limit?: number, services?: ReadonlyArray<string>) =>
      Effect.succeed(
        (services === undefined || services.length === 0
          ? MOCK_LOGS
          : MOCK_LOGS.filter((l) => services.includes(l.service))
        ).slice(-(limit ?? 100)),
      ),
  });

  return {
    layer,
    get stopped() {
      return stopped;
    },
    serviceCalls,
    readinessCalls,
    functionReloads,
    edgeRuntimeReloads,
  };
}

const functionsBundle: ResolvedFunctionsBundle = {
  env: { SHARED_SECRET: "shared-secret-value" },
  functions: [
    {
      name: "hello",
      verifyJWT: false,
      entrypointPath: "/project/supabase/functions/hello/index.ts",
      importMapPath: null,
      staticFiles: [],
      env: { FUNCTION_SECRET: "function-secret-value" },
    },
  ],
};

// ---------------------------------------------------------------------------
// Layer builder — DaemonServer backed by mock Stack on TCP port
// ---------------------------------------------------------------------------

function buildServerLayer(
  mock: ReturnType<typeof mockStack>,
): Layer.Layer<DaemonServer, never, never> {
  return DaemonServer.layer.pipe(
    Layer.provide(mock.layer),
    Layer.provide(NodeHttpServer.layer(() => http.createServer(), { port: 0 }).pipe(Layer.orDie)),
  );
}

function buildClientLayer(url: string): Layer.Layer<Stack, never, never> {
  const clientLayer = Layer.succeed(UnixHttpClient, {
    request: (socketPath, path, init) =>
      Effect.tryPromise({
        try: () => fetch(`${url}${path}`, init),
        catch: (cause) => new UnixHttpClientError({ socketPath, path, cause }),
      }),
  });
  return RemoteStack.layer("test.sock").pipe(Layer.provide(clientLayer));
}

// ---------------------------------------------------------------------------
// Tests — RemoteStack talks to DaemonServer via TCP (same logic as Unix socket)
// ---------------------------------------------------------------------------

describe("RemoteStack integration", () => {
  let serverRuntime: ManagedRuntime.ManagedRuntime<DaemonServer, never>;
  let clientRuntime: ManagedRuntime.ManagedRuntime<Stack, never>;
  let mock: ReturnType<typeof mockStack>;

  beforeAll(async () => {
    mock = mockStack();
    serverRuntime = ManagedRuntime.make(buildServerLayer(mock));
    const daemon = await serverRuntime.runPromise(DaemonServer);

    const addr = daemon.address;
    if (addr._tag !== "TcpAddress") throw new Error("Expected TcpAddress");
    const host = addr.hostname === "0.0.0.0" ? "127.0.0.1" : addr.hostname;
    const url = `http://${host}:${addr.port}`;
    clientRuntime = ManagedRuntime.make(buildClientLayer(url));
  });

  afterAll(async () => {
    await clientRuntime?.dispose();
    await serverRuntime?.dispose();
  });

  test("getInfo returns stack info", async () => {
    const info = await clientRuntime.runPromise(Effect.flatMap(Stack, (stack) => stack.getInfo()));
    expect(info).toEqual(MOCK_INFO);
  });

  test("getAllStates returns service states", async () => {
    const states = await clientRuntime.runPromise(
      Effect.flatMap(Stack, (stack) => stack.getAllStates()),
    );
    expect(states).toHaveLength(3);
    expect(states.at(0)?.name).toBe("postgres");
    expect(states.at(1)?.name).toBe("auth");
    expect(states.at(2)).toMatchObject({
      name: "edge-runtime",
      status: "Failed",
      pid: null,
      exitCode: null,
      error: "Health check failed and restart budget was exhausted",
    });
  });

  test("getState returns a single service state", async () => {
    const state = await clientRuntime.runPromise(
      Effect.flatMap(Stack, (stack) => stack.getState("postgres")),
    );
    expect(state.name).toBe("postgres");
    expect(state.status).toBe("Running");
  });

  test("getState fails for unknown service", async () => {
    const exit = await clientRuntime.runPromiseExit(
      Effect.flatMap(Stack, (stack) => stack.getState("unknown")),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("startService records the call", async () => {
    await clientRuntime.runPromise(
      Effect.flatMap(Stack, (stack) => stack.startService("postgres")),
    );
    expect(mock.serviceCalls).toContain("start:postgres");
  });

  test("startService fails for unknown service", async () => {
    const exit = await clientRuntime.runPromiseExit(
      Effect.flatMap(Stack, (stack) => stack.startService("unknown")),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("waitReady passes one validated finite override through the daemon", async () => {
    await clientRuntime.runPromise(
      Effect.flatMap(Stack, (stack) => stack.waitReady("auth", { mode: "finite", timeoutMs: 250 })),
    );
    expect(mock.serviceCalls).toContain("ready:auth");
    expect(mock.readinessCalls).toContainEqual({
      target: "auth",
      options: { mode: "finite", timeoutMs: 250 },
    });
  });

  test("waitReady rejects dot path segments locally", async () => {
    const error = await clientRuntime.runPromise(
      Effect.flatMap(Stack, (stack) => stack.waitReady("..")).pipe(Effect.flip),
    );
    expect(error._tag).toBe("ServiceNotFoundError");
    expect(mock.serviceCalls).not.toContain("ready:all");
  });

  test("waitAllReady sends explicit inherit semantics to the daemon", async () => {
    await clientRuntime.runPromise(Effect.flatMap(Stack, (stack) => stack.waitAllReady()));
    expect(mock.serviceCalls).toContain("ready:all");
    expect(mock.readinessCalls).toContainEqual({
      target: "stack",
      options: { mode: "inherit" },
    });
  });

  test("preserves StackReadinessError across the daemon transport", async () => {
    const failingMock = mockStack({ waitReadyTimeoutMs: 75 });
    const failingServer = ManagedRuntime.make(buildServerLayer(failingMock));
    let failingClient: ManagedRuntime.ManagedRuntime<Stack, never> | undefined;
    try {
      const daemon = await failingServer.runPromise(DaemonServer);
      const addr = daemon.address;
      if (addr._tag !== "TcpAddress") throw new Error("Expected TcpAddress");
      const host = addr.hostname === "0.0.0.0" ? "127.0.0.1" : addr.hostname;
      failingClient = ManagedRuntime.make(buildClientLayer(`http://${host}:${addr.port}`));

      const error = await failingClient.runPromise(
        Effect.flatMap(Stack, (stack) => stack.waitReady("auth")).pipe(Effect.flip),
      );
      expect(error._tag).toBe("StackReadinessError");
      if (error._tag === "StackReadinessError") {
        expect(error.target).toBe("auth");
        expect(error.timeoutMs).toBe(75);
      }
    } finally {
      await failingClient?.dispose();
      await failingServer.dispose();
    }
  });

  test("interrupting waitReady aborts the daemon request", async () => {
    let notifyRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      notifyRequestStarted = resolve;
    });
    let aborted = false;
    const clientLayer = Layer.succeed(UnixHttpClient, {
      request: (socketPath, path, init) =>
        Effect.tryPromise({
          try: () =>
            new Promise<Response>((_resolve, reject) => {
              notifyRequestStarted?.();
              init?.signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(new DOMException("Aborted", "AbortError"));
                },
                { once: true },
              );
            }),
          catch: (cause) => new UnixHttpClientError({ socketPath, path, cause }),
        }),
    });
    const runtime = ManagedRuntime.make(
      RemoteStack.layer("test.sock").pipe(Layer.provide(clientLayer)),
    );
    try {
      const fiber = runtime.runFork(Effect.flatMap(Stack, (stack) => stack.waitReady("auth")));
      await requestStarted;
      await runtime.runPromise(Fiber.interrupt(fiber));
      expect(aborted).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  test("preserves StackBuildError across remote service operations", async () => {
    const failingMock = mockStack({
      restartServiceReadyError: "restart failed readiness",
      startServiceBuildError: "stack is stopped",
      waitReadyBuildError: "service has not been activated",
    });
    const failingServer = ManagedRuntime.make(buildServerLayer(failingMock));
    let failingClient: ManagedRuntime.ManagedRuntime<Stack, never> | undefined;
    try {
      const daemon = await failingServer.runPromise(DaemonServer);
      const addr = daemon.address;
      if (addr._tag !== "TcpAddress") throw new Error("Expected TcpAddress");
      const host = addr.hostname === "0.0.0.0" ? "127.0.0.1" : addr.hostname;
      failingClient = ManagedRuntime.make(buildClientLayer(`http://${host}:${addr.port}`));

      const startError = await failingClient.runPromise(
        Effect.flatMap(Stack, (stack) => stack.startService("auth")).pipe(Effect.flip),
      );
      expect(startError._tag).toBe("StackBuildError");

      const readyError = await failingClient.runPromise(
        Effect.flatMap(Stack, (stack) => stack.waitReady("auth")).pipe(Effect.flip),
      );
      expect(readyError._tag).toBe("StackBuildError");

      const restartError = await failingClient.runPromise(
        Effect.flatMap(Stack, (stack) => stack.restartService("auth")).pipe(Effect.flip),
      );
      expect(restartError._tag).toBe("ServiceReadyError");
      if (restartError._tag === "ServiceReadyError") {
        expect(restartError.reason).toBe("restart failed readiness");
      }
    } finally {
      await failingClient?.dispose();
      await failingServer.dispose();
    }
  });

  test("preserves ServiceReadyError from remote startService", async () => {
    const failingMock = mockStack({ startServiceReadyError: "start failed readiness" });
    const failingServer = ManagedRuntime.make(buildServerLayer(failingMock));
    let failingClient: ManagedRuntime.ManagedRuntime<Stack, never> | undefined;
    try {
      const daemon = await failingServer.runPromise(DaemonServer);
      const addr = daemon.address;
      if (addr._tag !== "TcpAddress") throw new Error("Expected TcpAddress");
      const host = addr.hostname === "0.0.0.0" ? "127.0.0.1" : addr.hostname;
      failingClient = ManagedRuntime.make(buildClientLayer(`http://${host}:${addr.port}`));

      const error = await failingClient.runPromise(
        Effect.flatMap(Stack, (stack) => stack.startService("auth")).pipe(Effect.flip),
      );
      expect(error._tag).toBe("ServiceReadyError");
      if (error._tag === "ServiceReadyError") {
        expect(error.reason).toBe("start failed readiness");
      }
    } finally {
      await failingClient?.dispose();
      await failingServer.dispose();
    }
  });

  test("stopService records the call", async () => {
    await clientRuntime.runPromise(Effect.flatMap(Stack, (stack) => stack.stopService("auth")));
    expect(mock.serviceCalls).toContain("stop:auth");
  });

  test("restartService records the call", async () => {
    await clientRuntime.runPromise(
      Effect.flatMap(Stack, (stack) => stack.restartService("postgres")),
    );
    expect(mock.serviceCalls).toContain("restart:postgres");
  });

  test("reloadFunctions transports the validated bundle in a JSON body", async () => {
    await clientRuntime.runPromise(
      Effect.flatMap(Stack, (stack) => stack.reloadFunctions({ functions: functionsBundle })),
    );

    expect(mock.functionReloads).toEqual([{ functions: functionsBundle }]);
  });

  test("reloadFunctions returns a typed build error for an invalid bundle", async () => {
    const invalidBundle = {
      ...functionsBundle,
      functions: [{ ...functionsBundle.functions[0]!, entrypointPath: "relative/index.ts" }],
    };

    const error = await clientRuntime.runPromise(
      Effect.flatMap(Stack, (stack) =>
        stack.reloadFunctions({ functions: invalidBundle }).pipe(Effect.flip),
      ),
    );

    expect(error).toBeInstanceOf(StackBuildError);
    expect(error._tag).toBe("StackBuildError");
    if (error._tag === "StackBuildError") {
      expect(error.detail).toBe("Invalid Edge Functions reload payload");
    }
  });

  test("reloadEdgeRuntime records the call", async () => {
    await clientRuntime.runPromise(
      Effect.flatMap(Stack, (stack) =>
        stack.reloadEdgeRuntime({
          edgeRuntime: { policy: "oneshot" },
          functions: functionsBundle,
        }),
      ),
    );
    expect(mock.serviceCalls).toContain("reload-edge-runtime");
    expect(mock.edgeRuntimeReloads).toEqual([
      { edgeRuntime: { policy: "oneshot" }, functions: functionsBundle },
    ]);
  });

  test("logHistory returns entries", async () => {
    const entries = await clientRuntime.runPromise(
      Effect.flatMap(Stack, (stack) => stack.logHistory("postgres")),
    );
    expect(entries).toHaveLength(2);
    expect(entries.at(0)?.line).toBe("starting");
  });

  test("logHistory respects limit", async () => {
    const entries = await clientRuntime.runPromise(
      Effect.flatMap(Stack, (stack) => stack.logHistory("postgres", 1)),
    );
    expect(entries).toHaveLength(1);
    expect(entries.at(0)?.line).toBe("ready");
  });

  test("logHistoryAll returns merged entries", async () => {
    const entries = await clientRuntime.runPromise(
      Effect.flatMap(Stack, (stack) => stack.logHistoryAll(3)),
    );
    expect(entries.map((entry) => entry.line)).toEqual(["starting", "ready", "auth started"]);
  });

  test("logHistoryAll respects service filters", async () => {
    const entries = await clientRuntime.runPromise(
      Effect.flatMap(Stack, (stack) => stack.logHistoryAll(10, ["auth"])),
    );
    expect(entries).toHaveLength(1);
    expect(entries.at(0)?.service).toBe("auth");
  });

  test("stop calls through to daemon", async () => {
    // Use a fresh server so /stop doesn't affect other tests
    const freshMock = mockStack();
    const freshServer = ManagedRuntime.make(buildServerLayer(freshMock));
    try {
      const daemon = await freshServer.runPromise(DaemonServer);
      const addr = daemon.address;
      if (addr._tag !== "TcpAddress") throw new Error("Expected TcpAddress");
      const host = addr.hostname === "0.0.0.0" ? "127.0.0.1" : addr.hostname;
      const freshUrl = `http://${host}:${addr.port}`;

      const res = await fetch(`${freshUrl}/stop`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(freshMock.stopped).toBe(true);
    } finally {
      await freshServer.dispose();
    }
  });
});
