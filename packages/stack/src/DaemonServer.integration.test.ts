import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ServiceNotFoundError, type LogEntry } from "@supabase/process-compose";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DaemonServer } from "./DaemonServer.ts";
import { Stack, type StackInfo } from "./Stack.ts";
import { StackServiceState } from "./StackServiceState.ts";

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

const MOCK_STATES: ReadonlyArray<StackServiceState> = [POSTGRES_STATE];

const MOCK_LOGS: ReadonlyArray<LogEntry> = [
  { timestamp: 1000, service: "postgres", stream: "stdout", line: "starting" },
  { timestamp: 1001, service: "postgres", stream: "stdout", line: "ready" },
  { timestamp: 1002, service: "auth", stream: "stdout", line: "auth started" },
];

// ---------------------------------------------------------------------------
// Mock Stack
// ---------------------------------------------------------------------------

function mockStack() {
  let stopped = false;
  const serviceCalls: string[] = [];

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
        : Effect.sync(() => {
            serviceCalls.push(`restart:${name}`);
          }),
    reloadFunctions: () =>
      Effect.sync(() => {
        serviceCalls.push("reload-functions");
      }),
    reloadEdgeRuntime: () =>
      Effect.sync(() => {
        serviceCalls.push("reload-edge-runtime");
      }),
    getState: (name: string) =>
      name === "unknown"
        ? Effect.fail(new ServiceNotFoundError({ name }))
        : Effect.succeed(POSTGRES_STATE),
    getAllStates: () => Effect.succeed(MOCK_STATES),
    stateChanges: (name: string) =>
      name === "unknown"
        ? Effect.fail(new ServiceNotFoundError({ name }))
        : Effect.succeed(Stream.fromIterable(MOCK_STATES)),
    allStateChanges: () => Stream.fromIterable(MOCK_STATES),
    waitReady: (name: string) =>
      name === "unknown" ? Effect.fail(new ServiceNotFoundError({ name })) : Effect.void,
    waitAllReady: () => Effect.void,
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
  };
}

// ---------------------------------------------------------------------------
// Layer builder
// ---------------------------------------------------------------------------

function buildDaemonLayer(
  mock: ReturnType<typeof mockStack>,
): Layer.Layer<DaemonServer, never, never> {
  return DaemonServer.layer.pipe(
    Layer.provide(mock.layer),
    Layer.provide(NodeHttpServer.layer(() => http.createServer(), { port: 0 }).pipe(Layer.orDie)),
  ) as Layer.Layer<DaemonServer, never, never>;
}

function getUrl(address: {
  readonly _tag: string;
  readonly hostname?: string;
  readonly port?: number;
}): string {
  if (address._tag === "TcpAddress") {
    const host = address.hostname === "0.0.0.0" ? "127.0.0.1" : address.hostname;
    return `http://${host}:${address.port}`;
  }
  throw new Error(`Unexpected address type: ${address._tag}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DaemonServer", () => {
  let url: string;
  let runtime: ManagedRuntime.ManagedRuntime<DaemonServer, never>;
  let mock: ReturnType<typeof mockStack>;

  beforeAll(async () => {
    mock = mockStack();
    runtime = ManagedRuntime.make(buildDaemonLayer(mock));
    const daemon = await runtime.runPromise(DaemonServer.asEffect());
    url = getUrl(daemon.address);
  });

  afterAll(async () => {
    await runtime.dispose();
  });

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  test("GET /health returns 200 OK", async () => {
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  test("GET /status returns info and service states", async () => {
    const res = await fetch(`${url}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { info: StackInfo; services: StackServiceState[] };
    expect(body.info).toEqual(MOCK_INFO);
    expect(body.services).toHaveLength(1);
    expect(body.services.at(0)?.name).toBe("postgres");
    expect(body.services.at(0)?.status).toBe("Running");
  });

  // -------------------------------------------------------------------------
  // Status stream (SSE)
  // -------------------------------------------------------------------------

  test("GET /status/stream returns SSE events", async () => {
    const res = await fetch(`${url}/status/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: state");
    expect(text).toContain("postgres");
  });

  // -------------------------------------------------------------------------
  // Logs
  // -------------------------------------------------------------------------

  test("GET /logs returns SSE log events for all services", async () => {
    const res = await fetch(`${url}/logs`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: log");
    expect(text).toContain("starting");
    expect(text).toContain("auth started");
  });

  test("GET /logs filters SSE log events by repeated service query params", async () => {
    const res = await fetch(`${url}/logs?service=auth`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("auth started");
    expect(text).not.toContain("starting");
  });

  test("GET /logs/:service returns SSE log events for one service", async () => {
    const res = await fetch(`${url}/logs/postgres`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("starting");
    expect(text).toContain("ready");
    expect(text).not.toContain("auth started");
  });

  // -------------------------------------------------------------------------
  // Log history
  // -------------------------------------------------------------------------

  test("GET /logs/:service/history returns JSON log entries", async () => {
    const res = await fetch(`${url}/logs/postgres/history`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as LogEntry[];
    expect(body).toHaveLength(2);
    expect(body.at(0)?.line).toBe("starting");
    expect(body.at(1)?.line).toBe("ready");
  });

  test("GET /logs/:service/history respects limit param", async () => {
    const res = await fetch(`${url}/logs/postgres/history?limit=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as LogEntry[];
    expect(body).toHaveLength(1);
    expect(body.at(0)?.line).toBe("ready");
  });

  test("GET /logs/history returns merged log entries", async () => {
    const res = await fetch(`${url}/logs/history?limit=3`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as LogEntry[];
    expect(body).toHaveLength(3);
    expect(body.map((entry) => entry.line)).toEqual(["starting", "ready", "auth started"]);
  });

  test("GET /logs/history respects repeated service filters", async () => {
    const res = await fetch(`${url}/logs/history?service=auth`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as LogEntry[];
    expect(body).toHaveLength(1);
    expect(body.at(0)?.service).toBe("auth");
  });

  // -------------------------------------------------------------------------
  // Per-service control
  // -------------------------------------------------------------------------

  test("POST /services/:name/start returns 200", async () => {
    const res = await fetch(`${url}/services/postgres/start`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mock.serviceCalls).toContain("start:postgres");
  });

  test("POST /services/:name/stop returns 200", async () => {
    const res = await fetch(`${url}/services/postgres/stop`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mock.serviceCalls).toContain("stop:postgres");
  });

  test("POST /services/:name/restart returns 200", async () => {
    const res = await fetch(`${url}/services/postgres/restart`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mock.serviceCalls).toContain("restart:postgres");
  });

  test("POST /edge-runtime/reload returns 200", async () => {
    const res = await fetch(`${url}/edge-runtime/reload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ edgeRuntime: { policy: "oneshot" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mock.serviceCalls).toContain("reload-edge-runtime");
  });

  // -------------------------------------------------------------------------
  // Error cases — service not found
  // -------------------------------------------------------------------------

  test("POST /services/:name/start returns 404 for unknown service", async () => {
    const res = await fetch(`${url}/services/unknown/start`, { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("unknown");
  });

  test("POST /services/:name/stop returns 404 for unknown service", async () => {
    const res = await fetch(`${url}/services/unknown/stop`, { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("unknown");
  });

  test("POST /services/:name/restart returns 404 for unknown service", async () => {
    const res = await fetch(`${url}/services/unknown/restart`, { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("unknown");
  });

  // -------------------------------------------------------------------------
  // Stop (tested last since it modifies daemon state)
  // -------------------------------------------------------------------------

  test("POST /stop calls stack.stop and returns 200", async () => {
    expect(mock.stopped).toBe(false);
    const res = await fetch(`${url}/stop`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mock.stopped).toBe(true);
  });

  test("POST /stop resolves awaitShutdown", async () => {
    // Use a fresh runtime so /stop hasn't been called yet
    const freshMock = mockStack();
    const freshRuntime = ManagedRuntime.make(buildDaemonLayer(freshMock));
    try {
      const daemon = await freshRuntime.runPromise(DaemonServer.asEffect());
      const freshUrl = getUrl(daemon.address);

      // Start waiting for shutdown
      const shutdownPromise = freshRuntime.runPromise(daemon.awaitShutdown);

      // Trigger stop
      await fetch(`${freshUrl}/stop`, { method: "POST" });

      // awaitShutdown should resolve
      await shutdownPromise;
    } finally {
      await freshRuntime.dispose();
    }
  });
});
