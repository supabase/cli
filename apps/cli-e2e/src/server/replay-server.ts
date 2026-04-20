import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
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
import { matchFixture, resetCounters, type SequenceCounters } from "./request-matcher.ts";

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
  const recordedKeys = new Set<string>();

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
          stagingUrl!,
          options.fixturesDir,
          recordedKeys,
          scenario,
        );
      }

      // Replay mode: scenario takes priority over per-endpoint fixtures.
      if (scenario.name !== null) {
        return serveFromScenario(scenario, method, pathname, { query, body: requestBody });
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
  scenario: ScenarioState,
): Promise<Response> {
  const targetUrl = new URL(pathname, stagingUrl);
  for (const [k, v] of Object.entries(query)) {
    targetUrl.searchParams.set(k, v);
  }

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
  const responseHeaders: Record<string, string> = {};
  for (const [k, v] of upstreamRes.headers.entries()) {
    if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) responseHeaders[k] = v;
  }

  const rawPair = JSON.stringify({
    request: { method, path: pathname, query, headers: requestHeaders, body: requestBody },
    response: { status: upstreamRes.status, headers: responseHeaders, body: responseBody },
  });
  const { output } = applyPlaceholders(rawPair);
  const normalized = JSON.parse(output) as {
    request: FixtureRequest;
    response: FixtureResponse;
  };
  // Scenario interactions use unnumbered path placeholders so that comparison
  // against incoming paths (normalized the same way) is always idempotent.
  normalized.request.path = normalizeUrlPath(pathname);

  // Write to recorded/ (per-endpoint defaults, idempotent re-recording)
  const key = fixtureKey(method, pathname);
  const keyDir = join(fixturesDir, "recorded", key);

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

  // If a scenario is active, also append this interaction to interactions.json.
  if (scenario.name !== null) {
    scenario.log.push({ request: normalized.request, response: normalized.response });
    writeScenarioInteractions(fixturesDir, scenario.name, scenario.log);
  }

  return Response.json(responseBody, {
    status: upstreamRes.status,
    headers: {
      "content-type": upstreamRes.headers.get("content-type") ?? "application/json",
    },
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
  return Response.json(result.entry.response.body, {
    status: result.entry.response.status,
    headers: result.entry.response.headers,
  });
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

  if (JSON.stringify(expected.request.query) !== JSON.stringify(incoming.query)) {
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
    JSON.stringify(normalizePlaceholders(expected.request.body)) !==
      JSON.stringify(normalizePlaceholders(incoming.body))
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

  return Response.json(expected.response.body, {
    status: expected.response.status,
    headers: expected.response.headers,
  });
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
    return new Response(null, { status: 204 });
  }

  return new Response("Not Found", { status: 404 });
}
