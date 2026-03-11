import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as http from "node:http";
import { Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ApiProxy, type ProxyConfig } from "./ApiProxy.ts";

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

// Builds the full proxy layer backed by a Node HTTP server.
function buildProxyLayer(config: ProxyConfig): Layer.Layer<ApiProxy, never, never> {
  return ApiProxy.layer(config).pipe(
    Layer.provide(NodeHttpServer.layer(() => http.createServer(), { port: 0 }).pipe(Layer.orDie)),
    Layer.provide(FetchHttpClient.layer),
  ) as Layer.Layer<ApiProxy, never, never>;
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
      publishableKey: PUBLISHABLE_KEY,
      secretKey: SECRET_KEY,
      anonJwt: ANON_JWT,
      serviceRoleJwt: SERVICE_ROLE_JWT,
    };

    runtime = ManagedRuntime.make(buildProxyLayer(config));

    const proxy = await runtime.runPromise(ApiProxy.asEffect());
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
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });

  test("non-OPTIONS responses include CORS headers", async () => {
    const res = await fetch(`${proxyUrl}/health`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
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
      publishableKey: PUBLISHABLE_KEY,
      secretKey: SECRET_KEY,
      anonJwt: ANON_JWT,
      serviceRoleJwt: SERVICE_ROLE_JWT,
    };

    const deadRuntime = ManagedRuntime.make(buildProxyLayer(deadConfig));
    try {
      const deadProxy = await deadRuntime.runPromise(ApiProxy.asEffect());
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
});
