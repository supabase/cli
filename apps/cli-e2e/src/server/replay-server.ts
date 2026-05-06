import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { URL } from "node:url";
import type {
  FixtureEntry,
  FixtureRequest,
  FixtureResponse,
  FixtureStore,
} from "./fixture-loader.ts";
import { loadFixtures, loadScenario } from "./fixture-loader.ts";
import { applyPlaceholders, fixtureKey, normalizeUrlPath } from "./placeholder.ts";
import { matchFixture, resetCounters, sortBody, type SequenceCounters } from "./request-matcher.ts";
import type { PgFixture, PgMockHandle } from "./pg-mock.ts";

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

interface ScenarioState {
  name: string | null;
  queue: FixtureEntry[];
  index: number;
  log: Array<{ request: FixtureRequest; response: FixtureResponse }>;
}

interface GlobalErrorRef {
  value: { status: number; body: unknown } | null;
}

interface MultipartPart {
  headers: Record<string, string>;
  text?: string;
  base64?: string;
}

interface MultipartBody {
  __type: "multipart";
  boundary: string;
  parts: MultipartPart[];
}

/** Envelope used when a recorded body is not parseable as JSON — typically a
 *  Docker streaming endpoint (image pull progress, container logs, events).
 *  Stored as base64 so binary frames survive a JSON round-trip.  Replay decodes
 *  and returns the raw bytes verbatim. */
interface RawBody {
  __type: "raw";
  base64: string;
}

function isMultipartBody(body: unknown): body is MultipartBody {
  return (
    typeof body === "object" &&
    body !== null &&
    "__type" in body &&
    (body as { __type: unknown }).__type === "multipart"
  );
}

function isRawBody(body: unknown): body is RawBody {
  return (
    typeof body === "object" &&
    body !== null &&
    "__type" in body &&
    (body as { __type: unknown }).__type === "raw"
  );
}

function buildMultipartResponse(
  body: MultipartBody,
  status: number,
  headers: Record<string, string>,
): Response {
  const encoder = new TextEncoder();
  const { boundary, parts } = body;
  const chunks: Uint8Array[] = [];

  for (const part of parts) {
    chunks.push(encoder.encode(`--${boundary}\r\n`));
    for (const [k, v] of Object.entries(part.headers)) {
      chunks.push(encoder.encode(`${k}: ${v}\r\n`));
    }
    chunks.push(encoder.encode("\r\n"));
    if (part.base64 !== undefined) {
      chunks.push(Buffer.from(part.base64, "base64"));
    } else if (part.text !== undefined) {
      chunks.push(encoder.encode(part.text));
    }
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return new Response(result, {
    status,
    headers: {
      ...headers,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
  });
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
  /** Remove all error and rate-limit overrides (including global). */
  clearErrorOverrides(): void;
  /** Set the base URL to proxy /storage/v1/ calls to in record mode.
   *  e.g. "https://<projectRef>.supabase.red" */
  setStorageProxyUrl(url: string): void;
  /** Set the Authorization Bearer token to use when proxying storage calls
   *  to the staging storage URL in record mode. */
  setStorageProxyAuth(token: string): void;
  /** Set the Docker socket path for proxying versioned Docker API calls in record mode.
   *  e.g. "/var/run/docker.sock".  In replay mode the path is irrelevant — requests
   *  are served from pre-recorded fixtures like any other endpoint. */
  setDockerProxyUrl(socketPath: string): void;
}

interface ReplayServerOptions {
  /** Directory containing the fixtures/ tree. */
  fixturesDir: string;
  /** Port to listen on (0 = random). */
  port?: number;
  /** Optional Postgres mock server to control via /_ctrl/pg-* endpoints. */
  pgMock?: PgMockHandle;
}

export async function startReplayServer(options: ReplayServerOptions): Promise<ReplayServerHandle> {
  const isRecord = process.env["RECORD"] === "true";
  const stagingUrl = process.env["SUPABASE_STAGING_URL"];

  if (isRecord && !stagingUrl) {
    throw new Error("RECORD=true requires SUPABASE_STAGING_URL to be set");
  }

  // In record mode, wipe both fixture stores before serving any traffic.  The
  // recording session will repopulate only what the running tests exercise, so
  // any orphan from a prior session (e.g. a scenario whose test became test.todo,
  // or a recorded key the current run doesn't touch) is dropped.  Replay mode is
  // unaffected.
  if (isRecord) {
    rmSync(join(options.fixturesDir, "recorded"), { recursive: true, force: true });
    rmSync(join(options.fixturesDir, "scenarios"), { recursive: true, force: true });
  }

  const store: FixtureStore = isRecord ? new Map() : loadFixtures(options.fixturesDir);

  const counters: SequenceCounters = new Map();
  const requestLog: RecordedRequest[] = [];
  const errorOverrides = new Map<string, ErrorOverride>();
  const rateLimitOverrides = new Map<string, RateLimitOverride>();
  const recordedKeys = new Set<string>();
  let storageProxyUrl: string | undefined;
  let storageProxyAuth: string | undefined;
  let dockerProxySocketPath: string | undefined;

  const scenario: ScenarioState = { name: null, queue: [], index: 0, log: [] };
  const globalErrorRef: GlobalErrorRef = { value: null };

  function overrideKey(method: string, path: string): string {
    return `${method.toUpperCase()} ${path}`;
  }

  const server = Bun.serve({
    port: options.port ?? 0,
    async fetch(req: Request) {
      const url = new URL(req.url);

      // Control plane — not forwarded to CLI or staging
      if (url.pathname.startsWith("/_ctrl/")) {
        return handleControl(req, url, {
          requestLog,
          counters,
          errorOverrides,
          rateLimitOverrides,
          scenario,
          globalErrorRef,
          isRecord,
          fixturesDir: options.fixturesDir,
          pgMock: options.pgMock,
        });
      }

      const method = req.method;
      const pathname = url.pathname;
      const query = Object.fromEntries(url.searchParams.entries());
      const requestHeaders = Object.fromEntries(req.headers.entries());

      let requestBody: unknown = null;
      let rawBody: ReadableStream<Uint8Array> | null = null;
      const contentType = req.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        try {
          requestBody = await req.json();
        } catch {
          // not JSON — leave as null
        }
      } else {
        rawBody = req.body;
      }

      requestLog.push({
        method,
        pathname,
        query,
        headers: requestHeaders,
        body: requestBody,
        timestamp: new Date().toISOString(),
      });

      // Global error override — returned for all API requests regardless of endpoint.
      if (globalErrorRef.value) {
        return Response.json(globalErrorRef.value.body, { status: globalErrorRef.value.status });
      }

      // Per-endpoint error overrides
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
          rawBody,
          stagingUrl!,
          options.fixturesDir,
          recordedKeys,
          scenario,
          storageProxyUrl,
          storageProxyAuth,
          dockerProxySocketPath,
        );
      }

      // Replay mode: scenario takes priority for matching requests; out-of-band
      // requests (e.g., post-command telemetry calls inserted by the Go CLI after
      // every --project-ref command) fall through to the per-endpoint fixture store.
      if (scenario.name !== null) {
        const expected = scenario.queue[scenario.index];
        if (
          expected !== undefined &&
          expected.request.method.toUpperCase() === method.toUpperCase() &&
          expected.request.path === normalizeUrlPath(pathname)
        ) {
          return serveFromScenario(scenario, method, pathname, { query, body: requestBody });
        }
      }

      return serveFromFixtures(store, counters, method, pathname, { query, body: requestBody });
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
      globalErrorRef.value = null;
    },
    setStorageProxyUrl: (url) => {
      storageProxyUrl = url;
    },
    setStorageProxyAuth: (token) => {
      storageProxyAuth = token;
    },
    setDockerProxyUrl: (socketPath) => {
      dockerProxySocketPath = socketPath;
    },
  };
}

// Maximum number of recorded entries kept per endpoint key.  More than this
// adds no test coverage (the matcher wraps with `index % entries.length`) and
// allows polling loops to inflate the fixture tree indefinitely.
const MAX_FIXTURE_ENTRIES = 5;

const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "cf-ray",
  "cf-cache-status",
  "alt-svc",
  "nel",
  "report-to",
  "set-cookie",
  "connection",
  "date",
  "etag",
  "server",
  "strict-transport-security",
  "vary",
  "x-powered-by",
  "access-control-allow-credentials",
  "access-control-expose-headers",
]);

async function proxyAndRecord(
  method: string,
  pathname: string,
  query: Record<string, string>,
  requestHeaders: Record<string, string>,
  requestBody: unknown,
  rawBody: ReadableStream<Uint8Array> | null,
  stagingUrl: string,
  fixturesDir: string,
  recordedKeys: Set<string>,
  scenario: ScenarioState,
  storageProxyUrl?: string,
  storageProxyAuth?: string,
  dockerProxySocketPath?: string,
): Promise<Response> {
  const isStoragePath = pathname.startsWith("/storage/v1/");
  // Docker versioned API paths start with /v1. (decimal) to distinguish from
  // management API paths which start with /v1/ (slash). /_ping is the Docker
  // health-check endpoint (no version prefix).
  const isDockerPath = pathname.startsWith("/v1.") || pathname === "/_ping";

  const FORWARD_HEADERS = new Set(["authorization", "content-type", "accept", "user-agent"]);
  const upstreamHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(requestHeaders)) {
    if (FORWARD_HEADERS.has(k.toLowerCase())) upstreamHeaders[k] = v;
  }

  if (isDockerPath && dockerProxySocketPath) {
    const dockerResult = await proxyToDockerSocket(
      dockerProxySocketPath,
      method,
      pathname,
      query,
      upstreamHeaders,
      requestBody,
      rawBody,
    );
    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(dockerResult.headers)) {
      if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) responseHeaders[k] = v;
    }

    // Stream the response back to the caller immediately.  Recording happens
    // asynchronously after the body has fully drained — long-running streaming
    // endpoints (image pull progress, container logs) are not blocked on it.
    void recordDockerInteraction({
      bodyPromise: dockerResult.bodyPromise,
      method,
      pathname,
      query,
      requestHeaders,
      requestBody,
      responseStatus: dockerResult.status,
      responseHeaders,
      fixturesDir,
      recordedKeys,
      scenario,
    });

    return new Response(dockerResult.stream, {
      status: dockerResult.status,
      headers: responseHeaders,
    });
  }

  const targetBase = isStoragePath && storageProxyUrl ? storageProxyUrl : stagingUrl;
  const targetUrl = new URL(pathname, targetBase);
  for (const [k, v] of Object.entries(query)) {
    targetUrl.searchParams.set(k, v);
  }
  if (isStoragePath && storageProxyAuth) {
    upstreamHeaders["authorization"] = `Bearer ${storageProxyAuth}`;
  }

  const upstreamRes = await fetch(targetUrl.toString(), {
    method,
    headers: upstreamHeaders,
    body:
      method !== "GET" && method !== "HEAD"
        ? requestBody != null
          ? JSON.stringify(requestBody)
          : (rawBody ?? undefined)
        : undefined,
  });

  const responseBody = await upstreamRes
    .clone()
    .json()
    .catch(() => null);
  const responseHeaders: Record<string, string> = {};
  for (const [k, v] of upstreamRes.headers.entries()) {
    if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) responseHeaders[k] = v;
  }
  const upstreamStatus = upstreamRes.status;
  const responseContentType = upstreamRes.headers.get("content-type") ?? "application/json";

  recordFixture({
    method,
    pathname,
    query,
    requestHeaders,
    requestBody,
    responseStatus: upstreamStatus,
    responseHeaders,
    responseBody,
    fixturesDir,
    recordedKeys,
    scenario,
  });

  return buildApiResponse(responseBody, upstreamStatus, {
    ...responseHeaders,
    "content-type": responseContentType,
  });
}

/** Record a Docker interaction once its streamed body has fully drained.  Errors
 *  are logged but do not surface — recording is best-effort and must not affect
 *  the response the caller already received. */
async function recordDockerInteraction(params: {
  bodyPromise: Promise<Buffer>;
  method: string;
  pathname: string;
  query: Record<string, string>;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  fixturesDir: string;
  recordedKeys: Set<string>;
  scenario: ScenarioState;
}): Promise<void> {
  let body: Buffer;
  try {
    body = await params.bodyPromise;
  } catch (err) {
    console.error(
      `[replay-server] failed to capture Docker body for ${params.method} ${params.pathname}:`,
      err,
    );
    return;
  }

  let responseBody: unknown;
  if (body.length === 0) {
    responseBody = null;
  } else {
    try {
      responseBody = JSON.parse(body.toString("utf8"));
    } catch {
      // Non-JSON or chunked NDJSON (image pull progress, container log frames,
      // event streams) — preserve as a base64 envelope so replay can return the
      // bytes verbatim instead of silently dropping them.
      responseBody = { __type: "raw", base64: body.toString("base64") };
    }
  }

  recordFixture({
    method: params.method,
    pathname: params.pathname,
    query: params.query,
    requestHeaders: params.requestHeaders,
    requestBody: params.requestBody,
    responseStatus: params.responseStatus,
    responseHeaders: params.responseHeaders,
    responseBody,
    fixturesDir: params.fixturesDir,
    recordedKeys: params.recordedKeys,
    scenario: params.scenario,
  });
}

function recordFixture(params: {
  method: string;
  pathname: string;
  query: Record<string, string>;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  fixturesDir: string;
  recordedKeys: Set<string>;
  scenario: ScenarioState;
}): void {
  const rawPair = JSON.stringify({
    request: {
      method: params.method,
      path: params.pathname,
      query: params.query,
      headers: params.requestHeaders,
      body: params.requestBody,
    },
    response: {
      status: params.responseStatus,
      headers: params.responseHeaders,
      body: params.responseBody,
    },
  });
  const { output } = applyPlaceholders(rawPair);
  const normalized = JSON.parse(output) as {
    request: FixtureRequest;
    response: FixtureResponse;
  };
  // Scenario interactions use unnumbered path placeholders so that comparison
  // against incoming paths (normalized the same way) is always idempotent.
  normalized.request.path = normalizeUrlPath(params.pathname);

  const key = fixtureKey(params.method, params.pathname);
  const keyDir = join(params.fixturesDir, "recorded", key);

  if (!params.recordedKeys.has(key)) {
    params.recordedKeys.add(key);
    if (existsSync(keyDir)) {
      for (const file of readdirSync(keyDir)) {
        unlinkSync(join(keyDir, file));
      }
    }
  }

  mkdirSync(keyDir, { recursive: true });

  const nextIndex = nextFixtureIndex(keyDir);
  // Cap: the matcher's `index % entries.length` wrap means more than a few
  // entries adds bytes without adding coverage.  Stop persisting after the cap
  // is reached; the proxied response is still returned to the caller.
  if (nextIndex <= MAX_FIXTURE_ENTRIES) {
    const indexStr = nextIndex === 1 ? "default" : String(nextIndex);

    writeFileSync(
      join(keyDir, `${indexStr}.request.json`),
      JSON.stringify(normalized.request, null, 2),
    );
    writeFileSync(
      join(keyDir, `${indexStr}.response.json`),
      JSON.stringify(normalized.response, null, 2),
    );
  }

  // If a scenario is active, also append this interaction to interactions.json.
  if (params.scenario.name !== null) {
    params.scenario.log.push({ request: normalized.request, response: normalized.response });
    writeScenarioInteractions(params.fixturesDir, params.scenario.name, params.scenario.log);
  }
}

interface DockerProxyResult {
  status: number;
  headers: Record<string, string>;
  /** Streamed back to the caller — chunks arrive as Docker emits them, so
   *  long-running streaming endpoints (image pull progress, container logs,
   *  events) are not blocked on the full upstream body. */
  stream: ReadableStream<Uint8Array>;
  /** Resolves with the full concatenated body once the upstream stream ends.
   *  Used by `proxyAndRecord` to write the fixture *after* the response has
   *  flushed to the caller. */
  bodyPromise: Promise<Buffer>;
}

/** Idle timeout: abort if the upstream socket goes silent for this long.  The
 *  previous hard timeout (60s wall-clock) killed legitimate slow operations
 *  like first-time image pulls.  An idle timeout only kills truly stuck
 *  connections — anything still emitting progress events stays alive. */
const DOCKER_SOCKET_IDLE_TIMEOUT_MS = 60_000;

async function proxyToDockerSocket(
  socketPath: string,
  method: string,
  pathname: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  requestBody: unknown,
  rawBody: ReadableStream<Uint8Array> | null,
): Promise<DockerProxyResult> {
  const qStr = new URLSearchParams(query).toString();
  const path = qStr ? `${pathname}?${qStr}` : pathname;

  let bodyBuf: Buffer | undefined;
  if (requestBody != null) {
    bodyBuf = Buffer.from(JSON.stringify(requestBody), "utf8");
  } else if (rawBody != null) {
    const ab = await new Response(rawBody).arrayBuffer();
    bodyBuf = Buffer.from(ab);
  }

  // Strip hop-by-hop headers that must not be forwarded to the upstream socket.
  const HOP_BY_HOP = new Set([
    "connection",
    "transfer-encoding",
    "host",
    "keep-alive",
    "content-length",
  ]);
  const reqHeaders: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) reqHeaders[k] = v;
  }
  if (bodyBuf) {
    reqHeaders["Content-Length"] = bodyBuf.length;
  }

  return new Promise<DockerProxyResult>((resolve, reject) => {
    const req = httpRequest({ socketPath, method, path, headers: reqHeaders }, (res) => {
      if (res.statusCode == null) {
        reject(new Error("Docker socket returned response with no status code"));
        return;
      }

      const resHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (typeof v === "string") resHeaders[k] = v;
        else if (Array.isArray(v)) resHeaders[k] = v.join(", ");
      }

      const chunks: Buffer[] = [];
      let bodyResolve: (buf: Buffer) => void = () => {};
      let bodyReject: (err: Error) => void = () => {};
      const bodyPromise = new Promise<Buffer>((res2, rej2) => {
        bodyResolve = res2;
        bodyReject = rej2;
      });

      let lastActivity = Date.now();
      const idleTimer = setInterval(() => {
        if (Date.now() - lastActivity > DOCKER_SOCKET_IDLE_TIMEOUT_MS) {
          clearInterval(idleTimer);
          req.destroy(new Error(`Docker socket idle for ${DOCKER_SOCKET_IDLE_TIMEOUT_MS / 1000}s`));
        }
      }, 5_000);

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          res.on("data", (chunk: Buffer) => {
            lastActivity = Date.now();
            chunks.push(chunk);
            controller.enqueue(new Uint8Array(chunk));
          });
          res.on("end", () => {
            clearInterval(idleTimer);
            controller.close();
            bodyResolve(Buffer.concat(chunks));
          });
          res.on("error", (err) => {
            clearInterval(idleTimer);
            controller.error(err);
            bodyReject(err);
          });
        },
        cancel(reason) {
          clearInterval(idleTimer);
          req.destroy(reason instanceof Error ? reason : undefined);
        },
      });

      resolve({ status: res.statusCode, headers: resHeaders, stream, bodyPromise });
    });
    req.on("error", (err) => {
      req.destroy();
      reject(err);
    });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function writeScenarioInteractions(
  fixturesDir: string,
  scenarioName: string,
  interactions: Array<{ request: FixtureRequest; response: FixtureResponse }>,
): void {
  const scenarioDir = join(fixturesDir, "scenarios", scenarioName);
  mkdirSync(scenarioDir, { recursive: true });
  writeFileSync(join(scenarioDir, "interactions.json"), JSON.stringify(interactions, null, 2));
}

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
    if (file.startsWith("default.")) max = Math.max(max, 1);
  }
  return max + 1;
}

/** Build an API response, respecting HTTP no-body status codes (204, 304, 205). */
function buildApiResponse(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  if (status === 204 || status === 304 || status === 205) {
    return new Response(null, { status, headers });
  }
  if (isMultipartBody(body)) {
    return buildMultipartResponse(body, status, headers);
  }
  if (isRawBody(body)) {
    return new Response(Buffer.from(body.base64, "base64"), { status, headers });
  }
  // Docker endpoints frequently return an empty body where Response.json(null)
  // would emit the JSON literal "null".  Honor the empty intent for null bodies.
  if (body === null) {
    return new Response(null, { status, headers });
  }
  return Response.json(body, { status, headers });
}

function serveFromFixtures(
  store: FixtureStore,
  counters: SequenceCounters,
  method: string,
  pathname: string,
  incoming: { query: Record<string, string>; body: unknown },
): Response {
  const result = matchFixture(store, counters, method, pathname, incoming);
  if (!result.ok) {
    return new Response(JSON.stringify({ message: result.message }), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  return buildApiResponse(
    result.entry.response.body,
    result.entry.response.status,
    result.entry.response.headers,
  );
}

function normalizePlaceholders(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  return JSON.parse(applyPlaceholders(JSON.stringify(value)).output) as unknown;
}

function serveFromScenario(
  state: ScenarioState,
  method: string,
  pathname: string,
  incoming: { query: Record<string, string>; body: unknown },
): Response {
  const label = `${method.toUpperCase()} ${pathname}`;

  if (state.index >= state.queue.length) {
    return new Response(
      JSON.stringify({
        message: `Scenario "${state.name}" exhausted — unexpected request: ${label}`,
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const expected = state.queue[state.index];
  if (!expected) {
    return new Response(
      JSON.stringify({ message: `Scenario "${state.name}" — no entry at index ${state.index}` }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  state.index++;
  const position = state.index;

  // The stored path was written with normalizeUrlPath during recording; apply the
  // same transform to the incoming path so both sides are trivially comparable.
  if (
    expected.request.method.toUpperCase() !== method.toUpperCase() ||
    expected.request.path !== normalizeUrlPath(pathname)
  ) {
    return new Response(
      JSON.stringify({
        message: [
          `Scenario "${state.name}" interaction ${position} method/path mismatch:`,
          `  expected: ${expected.request.method.toUpperCase()} ${expected.request.path}`,
          `  actual:   ${label}`,
        ].join("\n"),
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (
    JSON.stringify(normalizePlaceholders(expected.request.query)) !==
    JSON.stringify(normalizePlaceholders(incoming.query))
  ) {
    return new Response(
      JSON.stringify({
        message: [
          `Scenario "${state.name}" interaction ${position} query mismatch for ${label}:`,
          `  expected: ${JSON.stringify(expected.request.query)}`,
          `  actual:   ${JSON.stringify(incoming.query)}`,
        ].join("\n"),
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (
    expected.request.body !== null &&
    JSON.stringify(sortBody(normalizePlaceholders(expected.request.body))) !==
      JSON.stringify(sortBody(normalizePlaceholders(incoming.body)))
  ) {
    return new Response(
      JSON.stringify({
        message: [
          `Scenario "${state.name}" interaction ${position} body mismatch for ${label}:`,
          `  expected: ${JSON.stringify(expected.request.body)}`,
          `  actual:   ${JSON.stringify(incoming.body)}`,
        ].join("\n"),
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  return buildApiResponse(
    expected.response.body,
    expected.response.status,
    expected.response.headers,
  );
}

interface ControlContext {
  requestLog: RecordedRequest[];
  counters: SequenceCounters;
  errorOverrides: Map<string, ErrorOverride>;
  rateLimitOverrides: Map<string, RateLimitOverride>;
  scenario: ScenarioState;
  globalErrorRef: GlobalErrorRef;
  isRecord: boolean;
  fixturesDir: string;
  pgMock?: PgMockHandle;
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

  if (subpath === "/scenario") {
    if (req.method === "POST") {
      const { name } = (await req.json()) as { name: string };

      if (!ctx.isRecord) {
        const interactions = loadScenario(join(ctx.fixturesDir, "scenarios"), name);
        if (!interactions) {
          return new Response(
            JSON.stringify({
              message: `Missing scenario: "${name}" — re-record with RECORD=true`,
            }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          );
        }
        ctx.scenario.queue = interactions;
      } else {
        ctx.scenario.queue = [];
        ctx.scenario.log = [];
      }

      ctx.scenario.name = name;
      ctx.scenario.index = 0;
      return new Response(null, { status: 204 });
    }

    if (req.method === "DELETE") {
      // In record mode, always flush interactions.json (even when empty) so that
      // tests which trigger a global error before any API call still get a scenario file.
      if (ctx.isRecord && ctx.scenario.name !== null) {
        writeScenarioInteractions(ctx.fixturesDir, ctx.scenario.name, ctx.scenario.log);
      }
      ctx.scenario.name = null;
      ctx.scenario.queue = [];
      ctx.scenario.index = 0;
      ctx.scenario.log = [];
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

  if (subpath === "/error-all" && req.method === "POST") {
    const body = (await req.json()) as { status: number; body?: unknown };
    ctx.globalErrorRef.value = {
      status: body.status,
      body: body.body ?? { message: "Error" },
    };
    return new Response(null, { status: 204 });
  }

  if (subpath === "/rate-limit" && req.method === "POST") {
    const body = (await req.json()) as {
      path: string;
      retryAfterSeconds: number;
    };
    ctx.rateLimitOverrides.set(body.path, { retryAfterSeconds: body.retryAfterSeconds });
    return new Response(null, { status: 204 });
  }

  if (subpath === "/overrides" && req.method === "DELETE") {
    ctx.errorOverrides.clear();
    ctx.rateLimitOverrides.clear();
    ctx.globalErrorRef.value = null;
    ctx.pgMock?.setState({ type: "empty" });
    return new Response(null, { status: 204 });
  }

  if (subpath === "/pg-fixture" && req.method === "POST") {
    if (!ctx.pgMock) {
      return new Response(JSON.stringify({ message: "No PG mock configured" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    const { key } = (await req.json()) as { key: string };
    const fixturePath = join(ctx.fixturesDir, "pg", `${key}.json`);
    let fixture: unknown;
    try {
      fixture = await Bun.file(fixturePath).json();
    } catch {
      return new Response(JSON.stringify({ message: `PG fixture not found: ${key}` }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    ctx.pgMock.setState({ type: "fixture", fixture: fixture as PgFixture });
    return new Response(null, { status: 204 });
  }

  if (subpath === "/pg-error" && req.method === "POST") {
    if (!ctx.pgMock) {
      return new Response(JSON.stringify({ message: "No PG mock configured" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    const error = (await req.json()) as { code: string; message: string; severity?: string };
    ctx.pgMock.setState({ type: "error", error });
    return new Response(null, { status: 204 });
  }

  return new Response("Not Found", { status: 404 });
}
