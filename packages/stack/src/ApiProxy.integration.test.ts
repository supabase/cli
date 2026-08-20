import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as http from "node:http";
import * as net from "node:net";
import { gzipSync } from "node:zlib";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ApiProxy, type ProxyConfig } from "./ApiProxy.ts";
import { StackNotRunningError, StackReadinessError } from "./errors.ts";
import { StackServiceActivator } from "./ServiceActivation.ts";
import type { ServiceName } from "./versions.ts";

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

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.stringify({
          path: url.pathname + url.search,
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        incomingRes.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        incomingRes.end(body);
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

// Sends a raw HTTP/1.1 request so the test controls body framing exactly —
// Bun's fetch nondeterministically buffers small ReadableStream bodies into
// content-length framing, so it cannot reliably produce a chunked request.
function rawHttpRequest(
  url: string,
  headerLines: string[],
  body: string,
): Promise<{ status: number; body: string }> {
  const port = Number(new URL(url).port);
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`${headerLines.join("\r\n")}\r\nConnection: close\r\n\r\n${body}`);
    });
    let data = "";
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      const status = Number(data.split(" ")[1]);
      const start = data.indexOf("{");
      const end = data.lastIndexOf("}");
      resolve({ status, body: start >= 0 ? data.slice(start, end + 1) : "" });
      socket.destroy();
    };
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      // Resolve as soon as a content-length-framed response is complete; the
      // server may hold the connection open for keep-alive.
      const headerEnd = data.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const contentLength = /\r\ncontent-length:\s*(\d+)/i.exec(data.slice(0, headerEnd));
      if (contentLength !== null && data.length >= headerEnd + 4 + Number(contentLength[1])) {
        finish();
      }
    });
    socket.on("close", finish);
    // Guard: surface whatever arrived instead of hanging the suite.
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
  });
}

// "chunked-payload" is 15 (0xf) bytes.
const CHUNKED_PAYLOAD = "f\r\nchunked-payload\r\n0\r\n\r\n";

// Builds the full proxy layer backed by a Node HTTP server.
function buildProxyLayer(
  config: ProxyConfig,
  activatorLayer: Layer.Layer<StackServiceActivator> = StackServiceActivator.noop,
): Layer.Layer<ApiProxy, never, never> {
  return ApiProxy.layer(config).pipe(
    Layer.provide(NodeHttpServer.layer(() => http.createServer(), { port: 0 }).pipe(Layer.orDie)),
    Layer.provide(activatorLayer),
  ) as Layer.Layer<ApiProxy, never, never>;
}

// Spins up a proxy for an ad-hoc config and returns its URL plus a disposer.
async function startProxy(
  config: ProxyConfig,
  activatorLayer?: Layer.Layer<StackServiceActivator>,
): Promise<{
  url: string;
  dispose: () => Promise<void>;
  awaitTerminalFailure: () => Promise<void>;
}> {
  const proxyRuntime = ManagedRuntime.make(buildProxyLayer(config, activatorLayer));
  const proxy = await proxyRuntime.runPromise(ApiProxy);
  const addr = proxy.address;
  let url = "";
  if (addr._tag === "TcpAddress") {
    const host = addr.hostname === "0.0.0.0" ? "127.0.0.1" : addr.hostname;
    url = `http://${host}:${addr.port}`;
  }
  return {
    url,
    dispose: () => proxyRuntime.dispose(),
    awaitTerminalFailure: () => proxyRuntime.runPromise(proxy.awaitTerminalFailure),
  };
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

  test("OPTIONS preflight allows whatever headers the client requests", async () => {
    const res = await fetch(`${proxyUrl}/rest/v1/users`, {
      method: "OPTIONS",
      headers: {
        // A mix of supabase-js headers, including ones no static allowlist
        // anticipated; the gateway must echo them all back.
        "access-control-request-headers":
          "apikey, x-supabase-api-version, prefer, x-retry-count, x-region",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // postgrest-js count-only queries and storage-js exists() use HEAD.
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-methods")).toContain("HEAD");
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "apikey, x-supabase-api-version, prefer, x-retry-count, x-region",
    );
    expect(res.headers.get("vary")).toContain("Access-Control-Request-Headers");
    // Hosted never sets expose-headers at the gateway; backends own it.
    expect(res.headers.get("access-control-expose-headers")).toBeNull();
    expect(res.headers.get("access-control-max-age")).toBe("3600");
  });

  test("non-OPTIONS responses include CORS headers", async () => {
    const res = await fetch(`${proxyUrl}/health`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toBeNull();
  });

  // The hosted gateway forwards OPTIONS on functions routes to the user's
  // function so user code can answer its own preflight (per the standard
  // _shared/cors.ts template); the local gateway must not intercept it.
  test("forwards OPTIONS on functions routes to the function", async () => {
    const res = await fetch(`${proxyUrl}/functions/v1/hello`, {
      method: "OPTIONS",
      headers: { "access-control-request-headers": "authorization" },
    });
    expect(res.status).toBe(200);
    const echoed = (await res.json()) as { path: string; method: string };
    expect(echoed.method).toBe("OPTIONS");
    expect(echoed.path).toBe("/hello");
    // The gateway added no CORS headers of its own; whatever the function
    // returns (here: nothing) is what the browser sees.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  // GoTrue's `POST /logout` carries no request body; streaming a nonexistent
  // body upstream used to surface as a 502 transport error.
  test("forwards a POST without a request body", async () => {
    const res = await fetch(`${proxyUrl}/auth/v1/logout?scope=global`, { method: "POST" });
    expect(res.status).toBe(200);
    const echoed = (await res.json()) as { path: string; method: string };
    expect(echoed.method).toBe("POST");
    expect(echoed.path).toBe("/logout?scope=global");
  });

  // A chunked request has no content-length; the proxy must classify it as
  // having a body and stream it through intact, re-framed as chunked by its
  // own transport.
  test("forwards a chunked request body", async () => {
    const res = await rawHttpRequest(
      proxyUrl,
      [
        "POST /rest/v1/users HTTP/1.1",
        "Host: 127.0.0.1",
        "Content-Type: text/plain",
        "Transfer-Encoding: chunked",
      ],
      CHUNKED_PAYLOAD,
    );
    expect(res.status).toBe(200);
    const echoed = JSON.parse(res.body) as {
      method: string;
      body: string;
      headers: Record<string, string>;
    };
    expect(echoed.method).toBe("POST");
    expect(echoed.body).toBe("chunked-payload");
    // The transport frames the body itself — chunked on Node, while Bun's
    // node:http may coalesce a small fully-written stream into length
    // framing. Either way the framing must describe the actual body.
    if (echoed.headers["transfer-encoding"] !== undefined) {
      expect(echoed.headers["transfer-encoding"]).toBe("chunked");
      expect(echoed.headers["content-length"]).toBeUndefined();
    } else {
      expect(echoed.headers["content-length"]).toBe("15");
    }
  });

  // Storage derives file-size enforcement from the request's content-length
  // and S3 SigV4 clients sign it, so a length-framed upload must reach the
  // backend with the identical content-length instead of being converted to
  // chunked by the proxy's own transport.
  test("preserves content-length framing on streamed uploads", async () => {
    const payload = "upload-payload-bytes";
    const res = await fetch(`${proxyUrl}/storage/v1/object/bucket/file.txt`, {
      method: "POST",
      body: payload,
    });
    expect(res.status).toBe(200);
    const echoed = (await res.json()) as { body: string; headers: Record<string, string> };
    expect(echoed.body).toBe(payload);
    expect(echoed.headers["content-length"]).toBe(String(payload.length));
    expect(echoed.headers["transfer-encoding"]).toBeUndefined();
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

  test("signals daemon teardown after a terminal activation failure", async () => {
    const activatorLayer = Layer.succeed(StackServiceActivator, {
      activate: () =>
        Effect.fail(
          new StackReadinessError({
            target: "postgrest",
            timeoutMs: 30_000,
            detail: "PostgREST did not become ready",
          }),
        ),
    });
    const proxy = await startProxy(configForPort(echoServer.port), activatorLayer);
    try {
      const res = await fetch(`${proxy.url}/rest/v1/users`);
      expect(res.status).toBe(503);
      await expect(proxy.awaitTerminalFailure()).resolves.toBeUndefined();
    } finally {
      await proxy.dispose();
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

  // The compressed body and its content-encoding pass through untouched; the
  // client (here: fetch) decompresses end to end. Only the upstream framing
  // headers and stale date are dropped.
  test("passes compressed function responses through to the client", async () => {
    const res = await fetch(`${proxyUrl}/functions/v1/encoded`);
    expect(res.status).toBe(200);
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
    // Keep ownership of the backend endpoint and deterministically refuse every
    // connection. A released port could be reclaimed by another process.
    const deadServer = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((request) => request.socket.destroy());
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const deadAddr = deadServer.address() as { port: number };
    const deadPort = deadAddr.port;
    const deadConfig: ProxyConfig = {
      listenPort: 0,
      gotruePort: deadPort,
      postgrestPort: deadPort,
      postgrestAdminPort: deadPort,
      edgeRuntimePort: deadPort,
      realtimePort: deadPort,
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
      await new Promise<void>((resolve, reject) =>
        deadServer.close((error) => (error === undefined ? resolve() : reject(error))),
      );
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

  // Edge-runtime supports streaming request bodies into functions; an unsized
  // (chunked) body must stream through instead of being buffered for replay.
  test("streams chunked bodies to functions without buffering", async () => {
    const res = await rawHttpRequest(
      proxyUrl,
      [
        "POST /functions/v1/stream HTTP/1.1",
        "Host: 127.0.0.1",
        "Content-Type: text/plain",
        "Transfer-Encoding: chunked",
      ],
      CHUNKED_PAYLOAD,
    );
    expect(res.status).toBe(200);
    const echoed = JSON.parse(res.body) as { body: string; headers: Record<string, string> };
    expect(echoed.body).toBe("chunked-payload");
    // Framing is transport-chosen (see "forwards a chunked request body");
    // the behavioral guard that this path streams instead of buffering for
    // replay is the companion no-retry test below.
    if (echoed.headers["transfer-encoding"] !== undefined) {
      expect(echoed.headers["transfer-encoding"]).toBe("chunked");
      expect(echoed.headers["content-length"]).toBeUndefined();
    } else {
      expect(echoed.headers["content-length"]).toBe("15");
    }
  });

  // A stream cannot be replayed once partially consumed, so cold-start retry
  // must not re-send non-replayable bodies.
  test("does not retry cold-start failures for non-replayable bodies", async () => {
    const backend = await startFlakyBackend({ failFirst: 1, body: "ok" });
    const proxy = await startProxy(configForPort(backend.port));
    try {
      const res = await rawHttpRequest(
        proxy.url,
        [
          "POST /functions/v1/hello HTTP/1.1",
          "Host: 127.0.0.1",
          "Content-Type: text/plain",
          "Transfer-Encoding: chunked",
        ],
        CHUNKED_PAYLOAD,
      );
      expect(res.status).toBe(502);
      expect(backend.attempts()).toBe(1);
    } finally {
      await proxy.dispose();
      await backend.stop();
    }
  });
});
