import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";
import type { FixtureStore } from "./fixture-loader.ts";
import { loadFixtures } from "./fixture-loader.ts";
import { applyPlaceholders, fixtureKey } from "./placeholder.ts";
import {
  describeRequest,
  matchFixture,
  resetCounters,
  type SequenceCounters,
} from "./request-matcher.ts";

interface RecordedRequest {
  method: string;
  pathname: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  timestamp: string;
}

interface ErrorOverride {
  status: number;
  body: unknown;
}

interface RateLimitOverride {
  retryAfterSeconds: number;
}

interface ReplayServerHandle {
  readonly url: string;
  readonly port: number;
  stop(): Promise<void>;
  /** Return all requests received since the last clearRequests() call. */
  getRequests(): RecordedRequest[];
  /** Clear the recorded request log and reset fixture sequence counters. */
  clearRequests(): void;
  /** Inject an error response for a specific method + path. */
  setErrorResponse(method: string, path: string, status: number, body?: unknown): void;
  /** Simulate 429 rate limiting for a path. */
  setRateLimit(path: string, retryAfterSeconds: number): void;
  /** Remove all error and rate-limit overrides. */
  clearErrorOverrides(): void;
}

interface ReplayServerOptions {
  /** Directory containing the fixtures/ tree. */
  fixturesDir: string;
  /** Port to listen on (0 = random). */
  port?: number;
}

export async function startReplayServer(options: ReplayServerOptions): Promise<ReplayServerHandle> {
  const isRecord = process.env["RECORD"] === "true";
  const stagingUrl = process.env["SUPABASE_STAGING_URL"];

  if (isRecord && !stagingUrl) {
    throw new Error("RECORD=true requires SUPABASE_STAGING_URL to be set");
  }

  const store: FixtureStore = isRecord ? new Map() : loadFixtures(options.fixturesDir);

  const counters: SequenceCounters = new Map();
  const requestLog: RecordedRequest[] = [];
  const errorOverrides = new Map<string, ErrorOverride>();
  const rateLimitOverrides = new Map<string, RateLimitOverride>();
  // Track which fixture keys have been written in this session so that the
  // first write clears stale files and re-recording is idempotent.
  const recordedKeys = new Set<string>();

  function overrideKey(method: string, path: string): string {
    return `${method.toUpperCase()} ${path}`;
  }

  const server = Bun.serve({
    port: options.port ?? 0,
    async fetch(req: Request) {
      const url = new URL(req.url);

      // Control plane — not forwarded to the CLI target or staging
      if (url.pathname.startsWith("/_ctrl/")) {
        return handleControl(req, url, {
          requestLog,
          counters,
          errorOverrides,
          rateLimitOverrides,
        });
      }

      const method = req.method;
      const pathname = url.pathname;
      const query = Object.fromEntries(url.searchParams.entries());
      const requestHeaders = Object.fromEntries(req.headers.entries());

      let requestBody: unknown = null;
      const contentType = req.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        try {
          requestBody = await req.json();
        } catch {
          // not JSON — leave as null
        }
      }

      // Record every incoming request for test assertions
      requestLog.push({
        method,
        pathname,
        query,
        headers: requestHeaders,
        body: requestBody,
        timestamp: new Date().toISOString(),
      });

      // Check error overrides first
      const errKey = overrideKey(method, pathname);
      const errorOverride = errorOverrides.get(errKey);
      if (errorOverride) {
        return Response.json(errorOverride.body, { status: errorOverride.status });
      }

      const rateLimitOverride = rateLimitOverrides.get(pathname);
      if (rateLimitOverride) {
        return new Response(JSON.stringify({ message: "Too Many Requests" }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(rateLimitOverride.retryAfterSeconds),
          },
        });
      }

      if (isRecord) {
        return proxyAndRecord(
          method,
          pathname,
          query,
          requestHeaders,
          requestBody,
          stagingUrl!,
          options.fixturesDir,
          recordedKeys,
        );
      }

      return serveFromFixtures(store, counters, method, pathname);
    },
  });

  const port = server.port ?? 0;
  const serverUrl = `http://127.0.0.1:${port}`;

  return {
    url: serverUrl,
    port,
    stop: () => server.stop(),
    getRequests: () => [...requestLog],
    clearRequests: () => {
      requestLog.length = 0;
      resetCounters(counters);
    },
    setErrorResponse: (method, path, status, body = { message: "Error" }) => {
      errorOverrides.set(overrideKey(method, path), { status, body });
    },
    setRateLimit: (path, retryAfterSeconds) => {
      rateLimitOverrides.set(path, { retryAfterSeconds });
    },
    clearErrorOverrides: () => {
      errorOverrides.clear();
      rateLimitOverrides.clear();
    },
  };
}

async function proxyAndRecord(
  method: string,
  pathname: string,
  query: Record<string, string>,
  requestHeaders: Record<string, string>,
  requestBody: unknown,
  stagingUrl: string,
  fixturesDir: string,
  recordedKeys: Set<string>,
): Promise<Response> {
  const targetUrl = new URL(pathname, stagingUrl);
  for (const [k, v] of Object.entries(query)) {
    targetUrl.searchParams.set(k, v);
  }

  // Only forward headers that are meaningful to the upstream API. Drop
  // hop-by-hop headers (host, connection, etc.) which are specific to the
  // local CLI→server leg and must not be sent to a different host.
  const FORWARD_HEADERS = new Set(["authorization", "content-type", "accept", "user-agent"]);
  const upstreamHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(requestHeaders)) {
    if (FORWARD_HEADERS.has(k.toLowerCase())) upstreamHeaders[k] = v;
  }

  const upstreamRes = await fetch(targetUrl.toString(), {
    method,
    headers: upstreamHeaders,
    body:
      method !== "GET" && method !== "HEAD" && requestBody != null
        ? JSON.stringify(requestBody)
        : undefined,
  });

  const responseBody: unknown = await upstreamRes
    .clone()
    .json()
    .catch(() => null);

  // Strip headers that describe the encoding of the raw wire bytes. We store
  // the decoded body as JSON, so these headers would cause the CLI to try
  // (and fail) to decompress a response that is already plain JSON.
  const STRIP_RESPONSE_HEADERS = new Set([
    "content-encoding",
    "transfer-encoding",
    "content-length",
  ]);
  const responseHeaders: Record<string, string> = {};
  for (const [k, v] of upstreamRes.headers.entries()) {
    if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) responseHeaders[k] = v;
  }

  // Normalize dynamic values before writing to disk
  const rawPair = JSON.stringify({
    request: {
      method,
      path: pathname,
      query,
      headers: requestHeaders,
      body: requestBody,
    },
    response: {
      status: upstreamRes.status,
      headers: responseHeaders,
      body: responseBody,
    },
  });
  const { output } = applyPlaceholders(rawPair);
  const normalized = JSON.parse(output) as {
    request: object;
    response: object;
  };

  // Write fixture pair — find the next available index in this key's directory
  const key = fixtureKey(method, pathname);
  const keyDir = join(fixturesDir, "recorded", key);

  // On first write for this key in this session, delete stale fixture files so
  // re-running in record mode is idempotent rather than appending indefinitely.
  if (!recordedKeys.has(key)) {
    recordedKeys.add(key);
    if (existsSync(keyDir)) {
      for (const file of readdirSync(keyDir)) {
        unlinkSync(join(keyDir, file));
      }
    }
  }

  mkdirSync(keyDir, { recursive: true });

  const nextIndex = nextFixtureIndex(keyDir);
  const indexStr = nextIndex === 1 ? "default" : String(nextIndex);

  writeFileSync(
    join(keyDir, `${indexStr}.request.json`),
    JSON.stringify(normalized.request, null, 2),
  );
  writeFileSync(
    join(keyDir, `${indexStr}.response.json`),
    JSON.stringify(normalized.response, null, 2),
  );

  return Response.json(responseBody, {
    status: upstreamRes.status,
    headers: {
      "content-type": upstreamRes.headers.get("content-type") ?? "application/json",
    },
  });
}

/** Find the next integer index to use when writing a new fixture pair. */
function nextFixtureIndex(keyDir: string): number {
  if (!existsSync(keyDir)) return 1;
  const files = readdirSync(keyDir);
  let max = 0;
  for (const file of files) {
    const match = file.match(/^(\d+)\.(request|response)\.json$/);
    if (match) {
      const n = match[1] != null ? parseInt(match[1], 10) : 0;
      if (n > max) max = n;
    }
    // "default" counts as 1
    if (file.startsWith("default.")) max = Math.max(max, 1);
  }
  return max + 1;
}

function serveFromFixtures(
  store: FixtureStore,
  counters: SequenceCounters,
  method: string,
  pathname: string,
): Response {
  const entry = matchFixture(store, counters, method, pathname);
  if (!entry) {
    const description = describeRequest(method, pathname);
    return new Response(
      JSON.stringify({
        message: `Missing fixture: ${description} — run with RECORD=true to record`,
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  return Response.json(entry.response.body, {
    status: entry.response.status,
    headers: entry.response.headers,
  });
}

interface ControlContext {
  requestLog: RecordedRequest[];
  counters: SequenceCounters;
  errorOverrides: Map<string, ErrorOverride>;
  rateLimitOverrides: Map<string, RateLimitOverride>;
}

async function handleControl(req: Request, url: URL, ctx: ControlContext): Promise<Response> {
  const subpath = url.pathname.slice("/_ctrl".length);

  if (subpath === "/requests") {
    if (req.method === "GET") {
      return Response.json(ctx.requestLog);
    }
    if (req.method === "DELETE") {
      ctx.requestLog.length = 0;
      resetCounters(ctx.counters);
      return new Response(null, { status: 204 });
    }
  }

  if (subpath === "/error" && req.method === "POST") {
    const body = (await req.json()) as {
      method: string;
      path: string;
      status: number;
      body?: unknown;
    };
    ctx.errorOverrides.set(`${body.method.toUpperCase()} ${body.path}`, {
      status: body.status,
      body: body.body ?? { message: "Error" },
    });
    return new Response(null, { status: 204 });
  }

  if (subpath === "/rate-limit" && req.method === "POST") {
    const body = (await req.json()) as {
      path: string;
      retryAfterSeconds: number;
    };
    ctx.rateLimitOverrides.set(body.path, {
      retryAfterSeconds: body.retryAfterSeconds,
    });
    return new Response(null, { status: 204 });
  }

  if (subpath === "/overrides" && req.method === "DELETE") {
    ctx.errorOverrides.clear();
    ctx.rateLimitOverrides.clear();
    return new Response(null, { status: 204 });
  }

  return new Response("Not Found", { status: 404 });
}
