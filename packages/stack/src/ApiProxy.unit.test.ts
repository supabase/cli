import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as http from "node:http";
import { gzipSync } from "node:zlib";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ApiProxy, isWebSocketUpgradeRequest, type ProxyConfig } from "./ApiProxy.ts";
import { StackNotRunningError } from "./errors.ts";
import { StackServiceActivator } from "./ServiceActivation.ts";
import type { ServiceName } from "./versions.ts";
import { proxyWebSocketConnectorLayer } from "./ProxyWebSocket.node.ts";

interface EchoServer {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

// Echo backend — returns request details as JSON so tests can assert on what
// the proxy forwarded.
function startEchoBackend(): Promise<EchoServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, incomingRes) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      if (url.pathname === "/encoded") {
        const body = gzipSync(JSON.stringify({ ok: true }));
        incomingRes.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Content-Encoding": "gzip",
          Date: new Date(0).toUTCString(),
        });
        incomingRes.end(body);
        return;
      }

      const body = JSON.stringify({
        path: url.pathname + url.search,
        method: req.method,
        headers: req.headers,
      });
      incomingRes.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      incomingRes.end(body);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected server address"));
        return;
      }
      resolve({
        port: addr.port,
        stop: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });

    server.on("error", reject);
  });
}

interface FlakyServer {
  readonly port: number;
  readonly attempts: () => number;
  readonly stop: () => Promise<void>;
}

interface WebSocketEchoServer {
  readonly port: number;
  readonly lastMessageWasBinary: () => boolean | undefined;
  readonly lastRequest: () =>
    | { readonly url: string | undefined; readonly host: string | undefined }
    | undefined;
  readonly stop: () => Promise<void>;
}

function startWebSocketEchoBackend(
  opts: { initialMessage?: string; close?: { code: number; reason: string } } = {},
): Promise<WebSocketEchoServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    const webSocketServer = new NodeWS.WebSocketServer({ server });
    let lastRequest: ReturnType<WebSocketEchoServer["lastRequest"]>;
    let lastMessageWasBinary: boolean | undefined;

    webSocketServer.on("connection", (socket, request) => {
      lastRequest = { url: request.url, host: request.headers.host };
      if (opts.initialMessage !== undefined) {
        socket.send(opts.initialMessage);
      }
      if (opts.close !== undefined) {
        socket.close(opts.close.code, opts.close.reason);
      }
      socket.on("message", (data, isBinary) => {
        lastMessageWasBinary = isBinary;
        socket.send(data, { binary: isBinary });
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Unexpected WebSocket server address"));
        return;
      }
      resolve({
        port: address.port,
        lastRequest: () => lastRequest,
        lastMessageWasBinary: () => lastMessageWasBinary,
        stop: () =>
          new Promise<void>((res, rej) => {
            webSocketServer.close(() => {
              server.close((error) => (error === undefined ? res() : rej(error)));
            });
          }),
      });
    });
    server.on("error", reject);
  });
}

// Backend that resets the connection (transport failure) for the first
// `failFirst` requests, then responds 200 with `body`. Mirrors an edge-runtime
// dropping connections while it cold-boots a user worker on first request.
function startFlakyBackend(opts: { failFirst: number; body: string }): Promise<FlakyServer> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const server = http.createServer((req, incomingRes) => {
      attempts += 1;
      if (attempts <= opts.failFirst) {
        req.socket.destroy();
        return;
      }
      incomingRes.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(opts.body),
      });
      incomingRes.end(opts.body);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected server address"));
        return;
      }
      resolve({
        port: addr.port,
        attempts: () => attempts,
        stop: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });

    server.on("error", reject);
  });
}

// Builds the full proxy layer backed by a Node HTTP server.
function buildProxyLayer(
  config: ProxyConfig,
  activatorLayer: Layer.Layer<StackServiceActivator> = StackServiceActivator.noop,
): Layer.Layer<ApiProxy, never, never> {
  return ApiProxy.layer(config).pipe(
    Layer.provide(NodeHttpServer.layer(() => http.createServer(), { port: 0 }).pipe(Layer.orDie)),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(activatorLayer),
    Layer.provide(proxyWebSocketConnectorLayer),
  ) as Layer.Layer<ApiProxy, never, never>;
}

// Spins up a proxy for an ad-hoc config and returns its URL plus a disposer.
async function startProxy(
  config: ProxyConfig,
  activatorLayer?: Layer.Layer<StackServiceActivator>,
): Promise<{ url: string; dispose: () => Promise<void> }> {
  const proxyRuntime = ManagedRuntime.make(buildProxyLayer(config, activatorLayer));
  const proxy = await proxyRuntime.runPromise(ApiProxy);
  const addr = proxy.address;
  let url = "";
  if (addr._tag === "TcpAddress") {
    const host = addr.hostname === "0.0.0.0" ? "127.0.0.1" : addr.hostname;
    url = `http://${host}:${addr.port}`;
  }
  return { url, dispose: () => proxyRuntime.dispose() };
}

describe("ApiProxy", () => {
  let echoServer: EchoServer;
  let proxyUrl: string;
  let runtime: ManagedRuntime.ManagedRuntime<ApiProxy, never>;

  const PUBLISHABLE_KEY = "sb_publishable_testkey";
  const SECRET_KEY = "sb_secret_testkey";
  const ANON_JWT = "test-anon-jwt-token";
  const SERVICE_ROLE_JWT = "test-service-role-jwt-token";

  beforeAll(async () => {
    echoServer = await startEchoBackend();
    const echoPort = echoServer.port;

    const config: ProxyConfig = {
      listenPort: 0,
      gotruePort: echoPort,
      postgrestPort: echoPort,
      postgrestAdminPort: echoPort,
      edgeRuntimePort: echoPort,
      realtimePort: echoPort,
      realtimeTenantId: "realtime-dev",
      storagePort: echoPort,
      pgmetaPort: echoPort,
      analyticsPort: echoPort,
      poolerPort: echoPort,
      studioPort: echoPort,
      publishableKey: PUBLISHABLE_KEY,
      secretKey: SECRET_KEY,
      anonJwt: ANON_JWT,
      serviceRoleJwt: SERVICE_ROLE_JWT,
    };

    runtime = ManagedRuntime.make(buildProxyLayer(config));

    const proxy = await runtime.runPromise(ApiProxy);
    const addr = proxy.address;
    if (addr._tag === "TcpAddress") {
      const host = addr.hostname === "0.0.0.0" ? "127.0.0.1" : addr.hostname;
      proxyUrl = `http://${host}:${addr.port}`;
    }
  });

  afterAll(async () => {
    await runtime.dispose();
    await echoServer.stop();
  });

  // ---------------------------------------------------------------------------
  // Health endpoint
  // ---------------------------------------------------------------------------

  test("GET /health returns 200 OK", async () => {
    const res = await fetch(`${proxyUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  test("POST /health returns 200 OK (any method)", async () => {
    const res = await fetch(`${proxyUrl}/health`, { method: "POST" });
    expect(res.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // CORS
  // ---------------------------------------------------------------------------

  test("OPTIONS returns 204 with CORS headers", async () => {
    const res = await fetch(`${proxyUrl}/rest/v1/users`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-headers")).toContain("apikey");
    expect(res.headers.get("access-control-expose-headers")).toContain("Content-Range");
    expect(res.headers.get("access-control-expose-headers")).toContain("sb-error-code");
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });

  test("non-OPTIONS responses include CORS headers", async () => {
    const res = await fetch(`${proxyUrl}/health`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("activates the routed service before forwarding", async () => {
    const activated: ServiceName[] = [];
    const activatorLayer = Layer.succeed(StackServiceActivator, {
      activate: (service) =>
        Effect.sync(() => {
          activated.push(service);
        }),
    });
    const proxy = await startProxy(configForPort(echoServer.port), activatorLayer);
    try {
      const res = await fetch(`${proxy.url}/rest/v1/users`);
      expect(res.status).toBe(200);
      expect(activated).toEqual(["postgrest"]);
    } finally {
      await proxy.dispose();
    }
  });

  test("returns 503 when the stack cannot activate a service", async () => {
    const activatorLayer = Layer.succeed(StackServiceActivator, {
      activate: () => Effect.fail(new StackNotRunningError({ phase: "idle" })),
    });
    const proxy = await startProxy(configForPort(echoServer.port), activatorLayer);
    try {
      const res = await fetch(`${proxy.url}/rest/v1/users`);
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
    } finally {
      await proxy.dispose();
    }
  });

  test("activates Realtime and bridges WebSocket frames", async () => {
    const backend = await startWebSocketEchoBackend();
    const activated: ServiceName[] = [];
    const activatorLayer = Layer.succeed(StackServiceActivator, {
      activate: (service) =>
        Effect.sync(() => {
          activated.push(service);
        }),
    });
    const proxy = await startProxy(configForPort(backend.port), activatorLayer);
    const frame = JSON.stringify(["1", "1", "realtime:public", "heartbeat", {}]);

    try {
      const echoed = await new Promise<string>((resolve, reject) => {
        const socket = new NodeWS.WebSocket(
          `${proxy.url.replace("http://", "ws://")}/realtime/v1/websocket?apikey=${PUBLISHABLE_KEY}&vsn=1.0.0`,
          "phoenix",
        );
        socket.once("open", () => socket.send(frame));
        socket.once("message", (data) => {
          resolve(data.toString());
          socket.close();
        });
        socket.once("error", reject);
      });

      expect(echoed).toBe(frame);
      expect(activated).toContain("realtime");
      expect(backend.lastRequest()).toEqual({
        url: `/socket/websocket?apikey=${ANON_JWT}&vsn=1.0.0`,
        host: "realtime-dev",
      });
    } finally {
      await proxy.dispose();
      await backend.stop();
    }
  });

  test("preserves binary Realtime frames whose payload is valid JSON", async () => {
    const backend = await startWebSocketEchoBackend();
    const proxy = await startProxy(configForPort(backend.port));
    const frame = Buffer.from(JSON.stringify({ type: "binary" }));

    try {
      const echoedAsBinary = await new Promise<boolean>((resolve, reject) => {
        const socket = new NodeWS.WebSocket(
          `${proxy.url.replace("http://", "ws://")}/realtime/v1/websocket`,
        );
        socket.once("open", () => socket.send(frame, { binary: true }));
        socket.once("message", (_data, isBinary) => {
          resolve(isBinary);
          socket.close();
        });
        socket.once("error", reject);
      });

      expect(echoedAsBinary).toBe(true);
      expect(backend.lastMessageWasBinary()).toBe(true);
    } finally {
      await proxy.dispose();
      await backend.stop();
    }
  });

  test.each(["GET", "POST"])(
    "rejects non-upgrade %s Realtime requests without activating the service",
    async (method) => {
      const activated: ServiceName[] = [];
      const activatorLayer = Layer.succeed(StackServiceActivator, {
        activate: (service) =>
          Effect.sync(() => {
            activated.push(service);
          }),
      });
      const proxy = await startProxy(configForPort(echoServer.port), activatorLayer);

      try {
        const response = await fetch(`${proxy.url}/realtime/v1/websocket`, { method });

        expect(response.status).toBe(426);
        expect(activated).toEqual([]);
      } finally {
        await proxy.dispose();
      }
    },
  );

  test("preserves the selected WebSocket protocol", async () => {
    const backend = await startWebSocketEchoBackend();
    const proxy = await startProxy(configForPort(backend.port));

    try {
      const selectedProtocol = await new Promise<string>((resolve, reject) => {
        const socket = new NodeWS.WebSocket(
          `${proxy.url.replace("http://", "ws://")}/realtime/v1/websocket`,
          ["phoenix", "fallback"],
        );
        socket.once("open", () => {
          resolve(socket.protocol);
          socket.close(4001, "client shutdown");
        });
        socket.once("error", reject);
      });

      expect(selectedProtocol).toBe("phoenix");
    } finally {
      await proxy.dispose();
      await backend.stop();
    }
  });

  test("preserves frames emitted as soon as the upstream connects", async () => {
    const backend = await startWebSocketEchoBackend({ initialMessage: "ready" });
    const proxy = await startProxy(configForPort(backend.port));

    try {
      const message = await new Promise<string>((resolve, reject) => {
        const socket = new NodeWS.WebSocket(
          `${proxy.url.replace("http://", "ws://")}/realtime/v1/websocket`,
        );
        socket.once("message", (data) => {
          resolve(data.toString());
          socket.close();
        });
        socket.once("error", reject);
      });

      expect(message).toBe("ready");
    } finally {
      await proxy.dispose();
      await backend.stop();
    }
  });

  // ---------------------------------------------------------------------------
  // Auth transformation — publishableKey → anonJwt
  // ---------------------------------------------------------------------------

  test("publishableKey in apikey header maps to anonJwt", async () => {
    const res = await fetch(`${proxyUrl}/rest/v1/users`, {
      headers: { apikey: PUBLISHABLE_KEY },
    });
    const body = (await res.json()) as { headers: Record<string, string> };
    expect(body.headers["authorization"]).toBe(`Bearer ${ANON_JWT}`);
  });

  // ---------------------------------------------------------------------------
  // Auth transformation — secretKey → serviceRoleJwt
  // ---------------------------------------------------------------------------

  test("secretKey in apikey header maps to serviceRoleJwt", async () => {
    const res = await fetch(`${proxyUrl}/rest/v1/users`, {
      headers: { apikey: SECRET_KEY },
    });
    const body = (await res.json()) as { headers: Record<string, string> };
    expect(body.headers["authorization"]).toBe(`Bearer ${SERVICE_ROLE_JWT}`);
  });

  // ---------------------------------------------------------------------------
  // Auth transformation — real JWT is preserved
  // ---------------------------------------------------------------------------

  test("real Authorization header is preserved", async () => {
    const realJwt = "Bearer eyJhbGciOiJIUzI1NiJ9.test";
    const res = await fetch(`${proxyUrl}/rest/v1/users`, {
      headers: { authorization: realJwt, apikey: PUBLISHABLE_KEY },
    });
    const body = (await res.json()) as { headers: Record<string, string> };
    expect(body.headers["authorization"]).toBe(realJwt);
  });

  // ---------------------------------------------------------------------------
  // Auth transformation — legacy Bearer sb_* is replaced by apikey mapping
  // ---------------------------------------------------------------------------

  test("legacy Bearer sb_* is replaced by apikey mapping", async () => {
    const res = await fetch(`${proxyUrl}/rest/v1/users`, {
      headers: {
        authorization: "Bearer sb_old_key",
        apikey: PUBLISHABLE_KEY,
      },
    });
    const body = (await res.json()) as { headers: Record<string, string> };
    expect(body.headers["authorization"]).toBe(`Bearer ${ANON_JWT}`);
  });

  // ---------------------------------------------------------------------------
  // Path stripping — auth routes
  // ---------------------------------------------------------------------------

  test("/auth/v1/token strips prefix", async () => {
    const res = await fetch(`${proxyUrl}/auth/v1/token`, {
      headers: { apikey: PUBLISHABLE_KEY },
    });
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe("/token");
  });

  // ---------------------------------------------------------------------------
  // Path stripping — REST routes
  // ---------------------------------------------------------------------------

  test("/rest/v1/users strips prefix", async () => {
    const res = await fetch(`${proxyUrl}/rest/v1/users`, {
      headers: { apikey: PUBLISHABLE_KEY },
    });
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe("/users");
  });

  describe("/functions/v1/ test strips prefix and transforms auth", () => {
    test("transforms to custom header", async () => {
      const res = await fetch(`${proxyUrl}/functions/v1/test`, {
        headers: { apikey: SECRET_KEY },
      });
      const body = (await res.json()) as { path: string; headers: Record<string, string> };
      expect(body.path).toBe("/test");
      expect(body.headers["sb-api-key"]).toBe(SERVICE_ROLE_JWT);
    });

    test("transforms to custom header without replacing original auth", async () => {
      const res = await fetch(`${proxyUrl}/functions/v1/test`, {
        headers: {
          apikey: SECRET_KEY,
          authorization: `Bearer ${SECRET_KEY}`,
        },
      });
      const body = (await res.json()) as { path: string; headers: Record<string, string> };
      expect(body.path).toBe("/test");
      expect(body.headers["authorization"]).toBe(`Bearer ${SECRET_KEY}`);
      expect(body.headers["sb-api-key"]).toBe(SERVICE_ROLE_JWT);
    });
  });

  test("strips upstream content-encoding metadata from proxied function responses", async () => {
    const res = await fetch(`${proxyUrl}/functions/v1/encoded`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("date")).not.toBe(new Date(0).toUTCString());
    expect(await res.json()).toEqual({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Auth open endpoints — no auth transformation
  // ---------------------------------------------------------------------------

  test("/auth/v1/verify does not transform auth", async () => {
    const res = await fetch(`${proxyUrl}/auth/v1/verify`, {
      headers: { apikey: PUBLISHABLE_KEY },
    });
    const body = (await res.json()) as { headers: Record<string, string> };
    // Open endpoints skip auth transformation; no Authorization header injected.
    expect(body.headers["authorization"]).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Proxy headers
  // ---------------------------------------------------------------------------

  test("adds X-Forwarded-Proto header", async () => {
    const res = await fetch(`${proxyUrl}/rest/v1/users`);
    const body = (await res.json()) as { headers: Record<string, string> };
    expect(body.headers["x-forwarded-proto"]).toBe("http");
  });

  // ---------------------------------------------------------------------------
  // 502 Bad Gateway when backend is unreachable
  // ---------------------------------------------------------------------------

  test("returns 502 when backend is unreachable", async () => {
    // Build a second proxy that points all routes to a port with nothing listening.
    // Use a port that was assigned then freed so we know nothing is there.
    const deadServer = await new Promise<http.Server>((resolve) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const deadAddr = deadServer.address() as { port: number };
    const deadPort = deadAddr.port;
    await new Promise<void>((res) => deadServer.close(() => res()));

    const deadConfig: ProxyConfig = {
      listenPort: 0,
      gotruePort: deadPort,
      postgrestPort: deadPort,
      postgrestAdminPort: deadPort,
      edgeRuntimePort: deadPort,
      realtimePort: deadPort,
      realtimeTenantId: "realtime-dev",
      storagePort: deadPort,
      pgmetaPort: deadPort,
      analyticsPort: deadPort,
      poolerPort: deadPort,
      studioPort: deadPort,
      publishableKey: PUBLISHABLE_KEY,
      secretKey: SECRET_KEY,
      anonJwt: ANON_JWT,
      serviceRoleJwt: SERVICE_ROLE_JWT,
    };

    const deadRuntime = ManagedRuntime.make(buildProxyLayer(deadConfig));
    try {
      const deadProxy = await deadRuntime.runPromise(ApiProxy);
      const deadAddr2 = deadProxy.address;
      let deadProxyUrl = "";
      if (deadAddr2._tag === "TcpAddress") {
        const host = deadAddr2.hostname === "0.0.0.0" ? "127.0.0.1" : deadAddr2.hostname;
        deadProxyUrl = `http://${host}:${deadAddr2.port}`;
      }

      const res = await fetch(`${deadProxyUrl}/rest/v1/users`);
      expect(res.status).toBe(502);
    } finally {
      await deadRuntime.dispose();
    }
  });

  // ---------------------------------------------------------------------------
  // Edge-function cold-start: retry transient connection failures
  // ---------------------------------------------------------------------------

  function configForPort(port: number): ProxyConfig {
    return {
      listenPort: 0,
      gotruePort: port,
      postgrestPort: port,
      postgrestAdminPort: port,
      edgeRuntimePort: port,
      realtimePort: port,
      realtimeTenantId: "realtime-dev",
      storagePort: port,
      pgmetaPort: port,
      analyticsPort: port,
      poolerPort: port,
      studioPort: port,
      publishableKey: PUBLISHABLE_KEY,
      secretKey: SECRET_KEY,
      anonJwt: ANON_JWT,
      serviceRoleJwt: SERVICE_ROLE_JWT,
    };
  }

  test("retries transient connection failures on the functions route until it is servable", async () => {
    const backend = await startFlakyBackend({ failFirst: 1, body: "hello" });
    const proxy = await startProxy(configForPort(backend.port));
    try {
      const res = await fetch(`${proxy.url}/functions/v1/hello`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello");
      expect(backend.attempts()).toBeGreaterThanOrEqual(2);
    } finally {
      await proxy.dispose();
      await backend.stop();
    }
  });

  test("does not retry non-functions routes on a connection failure", async () => {
    const backend = await startFlakyBackend({ failFirst: 1, body: "ok" });
    const proxy = await startProxy(configForPort(backend.port));
    try {
      const res = await fetch(`${proxy.url}/rest/v1/users`);
      expect(res.status).toBe(502);
      expect(backend.attempts()).toBe(1);
    } finally {
      await proxy.dispose();
      await backend.stop();
    }
  });

  test("replays the request body when retrying the functions route", async () => {
    let attempts = 0;
    // First request: reset the connection. Second: echo the received body back,
    // so the assertion fails unless the buffered body was re-sent on retry.
    const echoBody = await new Promise<FlakyServer>((resolve, reject) => {
      const server = http.createServer((req, incomingRes) => {
        attempts += 1;
        if (attempts === 1) {
          req.socket.destroy();
          return;
        }
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => {
          incomingRes.writeHead(200, {
            "Content-Type": "text/plain",
            "Content-Length": Buffer.byteLength(data),
          });
          incomingRes.end(data);
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Unexpected server address"));
          return;
        }
        resolve({
          port: addr.port,
          attempts: () => attempts,
          stop: () =>
            new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
        });
      });
      server.on("error", reject);
    });

    const proxy = await startProxy(configForPort(echoBody.port));
    try {
      const res = await fetch(`${proxy.url}/functions/v1/hello`, {
        method: "POST",
        body: "payload",
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("payload");
      expect(echoBody.attempts()).toBeGreaterThanOrEqual(2);
    } finally {
      await proxy.dispose();
      await echoBody.stop();
    }
  });
});

describe("isWebSocketUpgradeRequest", () => {
  const baseHeaders = {
    connection: "upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
  };

  test("accepts a canonical 16-byte WebSocket key", () => {
    expect(
      isWebSocketUpgradeRequest("GET", {
        ...baseHeaders,
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      }),
    ).toBe(true);
  });

  test.each(["", "not-base64", "c2hvcnQ="])(
    "rejects malformed WebSocket key %j before activation",
    (key) => {
      expect(isWebSocketUpgradeRequest("GET", { ...baseHeaders, "sec-websocket-key": key })).toBe(
        false,
      );
    },
  );

  test("rejects non-GET requests with valid upgrade headers before activation", () => {
    expect(
      isWebSocketUpgradeRequest("POST", {
        ...baseHeaders,
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      }),
    ).toBe(false);
  });
});
