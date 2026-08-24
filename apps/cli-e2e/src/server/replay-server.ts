import { BunServices } from "@effect/platform-bun";
import {
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Fiber,
  Layer,
  Logger,
  Option,
  Path,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMethod } from "effect/unstable/http";
import { URL } from "node:url";
import type {
  FixtureEntry,
  FixtureRequest,
  FixtureResponse,
  FixtureStore,
} from "./fixture-loader.ts";
import { loadFixtures, loadScenario } from "./fixture-loader.ts";
import {
  applyPlaceholders,
  fixtureKey,
  normalizeUrlPath,
  projectRefFromPath,
  restoreProjectRef,
} from "./placeholder.ts";
import { matchFixture, resetCounters, sortBody, type SequenceCounters } from "./request-matcher.ts";
import type { PgMockHandle } from "./pg-mock.ts";

const pathApi = Effect.runSync(Path.Path.pipe(Effect.provide(BunServices.layer)));
const join = (...parts: ReadonlyArray<string>): string => pathApi.join(...parts);

function runFs<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer), Effect.orDie));
}

function removePath(path: string): Promise<void> {
  return runFs(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(path, { recursive: true, force: true });
    }),
  );
}

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

const FixtureEntrySchema = Schema.Struct({
  request: Schema.Struct({
    method: Schema.String,
    path: Schema.String,
    query: Schema.Record(Schema.String, Schema.String),
    headers: Schema.Record(Schema.String, Schema.String),
    body: Schema.Unknown,
  }),
  response: Schema.Struct({
    status: Schema.Finite,
    headers: Schema.Record(Schema.String, Schema.String),
    body: Schema.Unknown,
  }),
});

const JsonString = Schema.fromJsonString(Schema.Unknown);

const ScenarioControlSchema = Schema.Struct({ name: Schema.String });
const ErrorControlSchema = Schema.Struct({
  method: Schema.String,
  path: Schema.String,
  status: Schema.Finite,
  body: Schema.optional(Schema.Unknown),
});
const ErrorAllControlSchema = Schema.Struct({
  status: Schema.Finite,
  body: Schema.optional(Schema.Unknown),
});
const RateLimitControlSchema = Schema.Struct({
  path: Schema.String,
  retryAfterSeconds: Schema.Finite,
});
const FixtureControlSchema = Schema.Struct({ key: Schema.String });
const PgErrorControlSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  severity: Schema.optional(Schema.String),
});
const PgFixtureSchema = Schema.Struct({
  columns: Schema.Array(Schema.String),
  typeOids: Schema.optional(Schema.Array(Schema.Finite)),
  rows: Schema.Array(Schema.Array(Schema.NullOr(Schema.String))),
});

function encodeJson(value: unknown): Effect.Effect<string, Schema.SchemaError> {
  return Schema.encodeEffect(JsonString)(value);
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
  /** Explicit harness mode; avoids hidden process-environment coupling. */
  mode: "record" | "replay";
  /** Staging API base URL required for record mode. */
  stagingUrl?: string;
}

export function startReplayServer(options: ReplayServerOptions): Promise<ReplayServerHandle> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const isRecord = options.mode === "record";
      const stagingUrl = options.stagingUrl;

      if (isRecord && !stagingUrl) {
        return yield* Effect.die(new Error("RECORD=true requires SUPABASE_STAGING_URL to be set"));
      }

      // In record mode, wipe both fixture stores before serving any traffic.  The
      // recording session will repopulate only what the running tests exercise, so
      // any orphan from a prior session (e.g. a scenario whose test became test.todo,
      // or a recorded key the current run doesn't touch) is dropped.  Replay mode is
      // unaffected.
      if (isRecord) {
        yield* Effect.promise(() => removePath(join(options.fixturesDir, "recorded")));
        yield* Effect.promise(() => removePath(join(options.fixturesDir, "scenarios")));
      }

      const store: FixtureStore = isRecord ? new Map() : yield* loadFixtures(options.fixturesDir);

      const counters: SequenceCounters = new Map();
      const requestLog: RecordedRequest[] = [];
      const errorOverrides = new Map<string, ErrorOverride>();
      const rateLimitOverrides = new Map<string, RateLimitOverride>();
      const recordedKeys = new Set<string>();
      // All recording state belongs to one server execution. A single permit
      // protects fixture files, the scenario log, and the shared interactions file
      // from independent request keys overwriting one another.
      const recordingLock = Semaphore.makeUnsafe(1);
      const recordingFibers = new Set<Fiber.Fiber<void, never>>();

      const drainRecordingFibers = Effect.whileLoop({
        while: () => recordingFibers.size > 0,
        body: () =>
          Effect.gen(function* () {
            const fibers = [...recordingFibers];
            yield* Effect.forEach(fibers, Fiber.await, {
              concurrency: "unbounded",
              discard: true,
            });
            yield* Effect.sync(() => {
              for (const fiber of fibers) recordingFibers.delete(fiber);
            });
          }),
        step: () => undefined,
      });
      let storageProxyUrl: string | undefined;
      let storageProxyAuth: string | undefined;
      let dockerProxySocketPath: string | undefined;

      const scenario: ScenarioState = { name: null, queue: [], index: 0, log: [] };
      const globalErrorRef: GlobalErrorRef = { value: null };

      function overrideKey(method: string, path: string): string {
        return `${method.toUpperCase()} ${path}`;
      }

      const serverContext = yield* Effect.context();
      const server = Bun.serve({
        port: options.port ?? 0,
        fetch(req: Request) {
          const url = new URL(req.url);
          return Effect.runPromiseWith(serverContext)(
            Effect.gen(function* () {
              // Control plane — not forwarded to CLI or staging
              if (url.pathname.startsWith("/_ctrl/")) {
                return yield* Effect.promise(() =>
                  handleControl(req, url, {
                    requestLog,
                    counters,
                    errorOverrides,
                    rateLimitOverrides,
                    scenario,
                    globalErrorRef,
                    isRecord,
                    fixturesDir: options.fixturesDir,
                    recordingLock,
                    pgMock: options.pgMock,
                  }),
                );
              }

              const method = req.method;
              const pathname = url.pathname;
              const query = Object.fromEntries(url.searchParams.entries());
              const requestHeaders = Object.fromEntries(req.headers.entries());

              let requestBody: unknown = null;
              let rawBody: ReadableStream<Uint8Array> | null = null;
              const contentType = req.headers.get("content-type") ?? "";
              if (contentType.includes("application/json")) {
                requestBody = yield* Effect.tryPromise(() => req.json()).pipe(
                  Effect.orElseSucceed(() => null),
                );
              } else {
                rawBody = req.body;
              }

              const timestamp = yield* DateTime.now;
              requestLog.push({
                method,
                pathname,
                query,
                headers: requestHeaders,
                body: requestBody,
                timestamp: DateTime.formatIso(timestamp),
              });

              // Global error override — returned for all API requests regardless of endpoint.
              if (globalErrorRef.value) {
                return Response.json(globalErrorRef.value.body, {
                  status: globalErrorRef.value.status,
                });
              }

              // Per-endpoint error overrides
              const errKey = overrideKey(method, pathname);
              const errorOverride = errorOverrides.get(errKey);
              if (errorOverride) {
                return Response.json(errorOverride.body, { status: errorOverride.status });
              }

              const rateLimitOverride = rateLimitOverrides.get(pathname);
              if (rateLimitOverride) {
                return Response.json(
                  { message: "Too Many Requests" },
                  {
                    status: 429,
                    headers: {
                      "Content-Type": "application/json",
                      "Retry-After": String(rateLimitOverride.retryAfterSeconds),
                    },
                  },
                );
              }

              if (isRecord) {
                if (!stagingUrl) return yield* Effect.die(new Error("Missing staging URL"));
                return yield* Effect.promise(() =>
                  proxyAndRecord(
                    method,
                    pathname,
                    query,
                    requestHeaders,
                    requestBody,
                    rawBody,
                    stagingUrl,
                    options.fixturesDir,
                    recordedKeys,
                    recordingLock,
                    recordingFibers,
                    scenario,
                    storageProxyUrl,
                    storageProxyAuth,
                    dockerProxySocketPath,
                  ),
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
                  return serveFromScenario(scenario, method, pathname, {
                    query,
                    body: requestBody,
                  });
                }
              }

              return serveFromFixtures(store, counters, method, pathname, {
                query,
                body: requestBody,
              });
            }).pipe(Effect.provide(BunServices.layer), Effect.orDie),
          );
        },
      });

      const port = server.port ?? 0;
      const serverUrl = `http://127.0.0.1:${port}`;

      return {
        url: serverUrl,
        port,
        stop: () =>
          Effect.runPromiseWith(serverContext)(
            Effect.promise(() => server.stop()).pipe(Effect.andThen(drainRecordingFibers)),
          ),
        getRequests: () => [...requestLog],
        clearRequests: () => {
          requestLog.length = 0;
          resetCounters(counters);
        },
        setErrorResponse: (
          method: string,
          path: string,
          status: number,
          body: unknown = { message: "Error" },
        ) => {
          errorOverrides.set(overrideKey(method, path), { status, body });
        },
        setRateLimit: (path: string, retryAfterSeconds: number) => {
          rateLimitOverrides.set(path, { retryAfterSeconds });
        },
        clearErrorOverrides: () => {
          errorOverrides.clear();
          rateLimitOverrides.clear();
          globalErrorRef.value = null;
        },
        setStorageProxyUrl: (url: string) => {
          storageProxyUrl = url;
        },
        setStorageProxyAuth: (token: string) => {
          storageProxyAuth = token;
        },
        setDockerProxyUrl: (socketPath: string) => {
          dockerProxySocketPath = socketPath;
        },
      };
    }).pipe(Effect.provide(BunServices.layer), Effect.orDie),
  );
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

function proxyAndRecord(
  method: string,
  pathname: string,
  query: Record<string, string>,
  requestHeaders: Record<string, string>,
  requestBody: unknown,
  rawBody: ReadableStream<Uint8Array> | null,
  stagingUrl: string,
  fixturesDir: string,
  recordedKeys: Set<string>,
  recordingLock: Semaphore.Semaphore,
  recordingFibers: Set<Fiber.Fiber<void, never>>,
  scenario: ScenarioState,
  storageProxyUrl?: string,
  storageProxyAuth?: string,
  dockerProxySocketPath?: string,
): Promise<Response> {
  return Effect.runPromise(
    Effect.gen(function* () {
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
        const dockerResult = yield* Effect.promise(() =>
          proxyToDockerSocket(
            dockerProxySocketPath,
            method,
            pathname,
            query,
            upstreamHeaders,
            requestBody,
            rawBody,
          ),
        );
        const responseHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(dockerResult.headers)) {
          if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) responseHeaders[k] = v;
        }

        // Stream the response back to the caller immediately.  Recording happens
        // asynchronously after the body has fully drained — long-running streaming
        // endpoints (image pull progress, container logs) are not blocked on it.
        const recordingFiber = yield* Effect.forkDetach(
          Effect.promise(() =>
            recordDockerInteraction({
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
              recordingLock,
              scenario,
            }),
          ),
        );
        recordingFibers.add(recordingFiber);
        recordingFiber.addObserver(() => recordingFibers.delete(recordingFiber));

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

      if (!HttpMethod.isHttpMethod(method)) {
        return yield* Effect.die(new Error(`Unsupported HTTP method: ${method}`));
      }
      let request = HttpClientRequest.make(method)(targetUrl, { headers: upstreamHeaders });
      if (method !== "GET" && method !== "HEAD") {
        if (requestBody != null) {
          request = yield* HttpClientRequest.bodyJson(request, requestBody);
        } else if (rawBody !== null) {
          const body = yield* Effect.tryPromise(() => new Response(rawBody).arrayBuffer());
          request = HttpClientRequest.bodyUint8Array(
            request,
            new Uint8Array(body),
            upstreamHeaders["content-type"],
          );
        }
      }

      const upstreamRes = yield* HttpClient.execute(request);
      const responseBody = yield* upstreamRes.json.pipe(Effect.orElseSucceed(() => null));
      const responseHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) responseHeaders[k] = v;
      }
      const upstreamStatus = upstreamRes.status;
      const responseContentType = upstreamRes.headers["content-type"] ?? "application/json";

      yield* Effect.promise(() =>
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
          recordingLock,
          scenario,
        }),
      );

      return buildApiResponse(
        responseBody,
        upstreamStatus,
        {
          ...responseHeaders,
          "content-type": responseContentType,
        },
        projectRefFromPath(pathname),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
  );
}

/** Record a Docker interaction once its streamed body has fully drained.  Errors
 *  are logged but do not surface — recording is best-effort and must not affect
 *  the response the caller already received. */
function recordDockerInteraction(params: {
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
  recordingLock: Semaphore.Semaphore;
  scenario: ScenarioState;
}): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const body = yield* Effect.tryPromise(() => params.bodyPromise).pipe(
        Effect.map(Option.some),
        Effect.catch((err) =>
          Effect.logError(
            `[replay-server] failed to capture Docker body for ${params.method} ${params.pathname}: ${String(err)}`,
          ).pipe(Effect.as(Option.none())),
        ),
      );
      let responseBody: unknown;
      if (Option.isNone(body)) return;
      if (body.value.length === 0) {
        responseBody = null;
      } else {
        const parsed = yield* Schema.decodeEffect(JsonString)(body.value.toString("utf8")).pipe(
          Effect.map(Option.some),
          Effect.orElseSucceed(() => Option.none()),
        );
        if (Option.isNone(parsed)) {
          // Non-JSON or chunked NDJSON (image pull progress, container log frames,
          // event streams) — preserve as a base64 envelope so replay can return the
          // bytes verbatim instead of silently dropping them.
          responseBody = { __type: "raw", base64: body.value.toString("base64") };
        } else {
          responseBody = parsed.value;
        }
      }

      yield* Effect.promise(() =>
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
          recordingLock: params.recordingLock,
          scenario: params.scenario,
        }),
      );
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, Logger.layer([Logger.defaultLogger]))),
      Effect.orDie,
    ),
  );
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
  recordingLock: Semaphore.Semaphore;
  scenario: ScenarioState;
}): Promise<void> {
  const key = fixtureKey(params.method, params.pathname);

  return runFs(
    params.recordingLock.withPermit(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const rawPair = yield* encodeJson({
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
        const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(FixtureEntrySchema))(
          output,
        );
        const normalized: FixtureEntry = {
          request: {
            method: decoded.request.method,
            path: decoded.request.path,
            query: { ...decoded.request.query },
            headers: { ...decoded.request.headers },
            body: decoded.request.body,
          },
          response: {
            status: decoded.response.status,
            headers: { ...decoded.response.headers },
            body: decoded.response.body,
          },
        };
        normalized.request.path = normalizeUrlPath(params.pathname);

        const keyDir = join(params.fixturesDir, "recorded", key);

        if (!params.recordedKeys.has(key)) {
          params.recordedKeys.add(key);
          if (yield* fs.exists(keyDir)) {
            const files = yield* fs.readDirectory(keyDir);
            yield* Effect.forEach(files, (file) => fs.remove(join(keyDir, file)), {
              discard: true,
            });
          }
        }

        yield* fs.makeDirectory(keyDir, { recursive: true });
        const nextIndex = yield* nextFixtureIndex(keyDir);
        if (nextIndex <= MAX_FIXTURE_ENTRIES) {
          const indexStr = nextIndex === 1 ? "default" : String(nextIndex);
          yield* fs.writeFileString(
            join(keyDir, `${indexStr}.request.json`),
            yield* encodeJson(normalized.request),
          );
          yield* fs.writeFileString(
            join(keyDir, `${indexStr}.response.json`),
            yield* encodeJson(normalized.response),
          );
        }

        if (params.scenario.name !== null) {
          params.scenario.log.push({ request: normalized.request, response: normalized.response });
          yield* writeScenarioInteractions(
            params.fixturesDir,
            params.scenario.name,
            params.scenario.log,
          );
        }
      }),
    ),
  );
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

function proxyToDockerSocket(
  socketPath: string,
  method: string,
  pathname: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  requestBody: unknown,
  rawBody: ReadableStream<Uint8Array> | null,
): Promise<DockerProxyResult> {
  const requestInit: globalThis.RequestInit = {};
  Object.defineProperty(requestInit, "unix", {
    value: socketPath,
    enumerable: true,
  });
  return Effect.runPromise(
    Effect.gen(function* () {
      const qStr = new URLSearchParams(query).toString();
      const path = qStr ? `${pathname}?${qStr}` : pathname;

      // Strip hop-by-hop headers that must not be forwarded to the upstream socket.
      const HOP_BY_HOP = new Set([
        "connection",
        "transfer-encoding",
        "host",
        "keep-alive",
        "content-length",
      ]);
      const reqHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) reqHeaders[k] = v;
      }

      if (!HttpMethod.isHttpMethod(method)) {
        return yield* Effect.die(new Error(`Unsupported HTTP method: ${method}`));
      }
      let request = HttpClientRequest.make(method)(`http://localhost${path}`, {
        headers: reqHeaders,
      });
      if (requestBody != null) {
        request = yield* HttpClientRequest.bodyJson(request, requestBody);
      } else if (rawBody !== null) {
        const body = yield* Effect.tryPromise(() => new Response(rawBody).arrayBuffer());
        request = HttpClientRequest.bodyUint8Array(
          request,
          new Uint8Array(body),
          reqHeaders["content-type"],
        );
      }

      const response = yield* HttpClient.execute(request);
      const responseStream = yield* Stream.toReadableStreamEffect(
        response.stream.pipe(
          Stream.timeoutOrElse({
            duration: Duration.millis(DOCKER_SOCKET_IDLE_TIMEOUT_MS),
            orElse: () => Stream.fail(new Error("Docker socket response stream timed out")),
          }),
          Stream.orDie,
        ),
      );
      const [stream, bodyStream] = responseStream.tee();
      return {
        status: response.status,
        headers: { ...response.headers },
        stream,
        bodyStream,
      };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          Layer.succeed(FetchHttpClient.RequestInit, requestInit),
        ),
      ),
      Effect.orDie,
    ),
  ).then(({ bodyStream, ...result }) => ({
    ...result,
    bodyPromise: Effect.runPromise(
      Effect.tryPromise(() => new Response(bodyStream).arrayBuffer()).pipe(
        Effect.map((body) => Buffer.from(body)),
        Effect.orDie,
      ),
    ),
  }));
}

function writeScenarioInteractions(
  fixturesDir: string,
  scenarioName: string,
  interactions: Array<{ request: FixtureRequest; response: FixtureResponse }>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scenarioDir = join(fixturesDir, "scenarios", scenarioName);
    yield* fs.makeDirectory(scenarioDir, { recursive: true });
    yield* fs.writeFileString(
      join(scenarioDir, "interactions.json"),
      yield* encodeJson(interactions),
    );
  });
}

function nextFixtureIndex(keyDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(keyDir))) return 1;
    const files = yield* fs.readDirectory(keyDir);
    let max = 0;
    for (const file of files) {
      const match = /^(\d+)\.(request|response)\.json$/.exec(file);
      if (match?.[1] !== undefined) {
        const n = Number.parseInt(match[1], 10);
        if (n > max) max = n;
      }
      if (file.startsWith("default.")) max = Math.max(max, 1);
    }
    return max + 1;
  });
}

/** Build an API response, respecting HTTP no-body status codes (204, 304, 205).
 *  `projectRef` is the ref from the request path, used to restore short
 *  `__PROJECT_REF__` placeholders to schema-valid 20-char refs in JSON bodies. */
function buildApiResponse(
  body: unknown,
  status: number,
  headers: Record<string, string>,
  projectRef: string,
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
  return new Response(restoreProjectRef(JSON.stringify(body), projectRef), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
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
    projectRefFromPath(pathname),
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
    projectRefFromPath(pathname),
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
  recordingLock: Semaphore.Semaphore;
  pgMock?: PgMockHandle;
}

function handleControl(req: Request, url: URL, ctx: ControlContext): Promise<Response> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const subpath = url.pathname.slice("/_ctrl".length);

      if (subpath === "/requests") {
        if (req.method === "GET") return Response.json(ctx.requestLog);
        if (req.method === "DELETE") {
          ctx.requestLog.length = 0;
          resetCounters(ctx.counters);
          return new Response(null, { status: 204 });
        }
      }

      if (subpath === "/scenario") {
        if (req.method === "POST") {
          const body = yield* Effect.tryPromise(() => req.json()).pipe(
            Effect.flatMap((value) => Schema.decodeUnknownEffect(ScenarioControlSchema)(value)),
          );
          return yield* ctx.recordingLock.withPermit(
            Effect.gen(function* () {
              if (!ctx.isRecord) {
                const interactions = yield* loadScenario(
                  join(ctx.fixturesDir, "scenarios"),
                  body.name,
                );
                if (!interactions) {
                  return Response.json(
                    { message: `Missing scenario: "${body.name}" — re-record with RECORD=true` },
                    { status: 404 },
                  );
                }
                ctx.scenario.queue = interactions;
              } else {
                ctx.scenario.queue = [];
                ctx.scenario.log = [];
              }
              ctx.scenario.name = body.name;
              ctx.scenario.index = 0;
              return new Response(null, { status: 204 });
            }),
          );
        }

        if (req.method === "DELETE") {
          return yield* ctx.recordingLock.withPermit(
            Effect.gen(function* () {
              if (ctx.isRecord && ctx.scenario.name !== null) {
                yield* writeScenarioInteractions(
                  ctx.fixturesDir,
                  ctx.scenario.name,
                  ctx.scenario.log,
                );
              }
              ctx.scenario.name = null;
              ctx.scenario.queue = [];
              ctx.scenario.index = 0;
              ctx.scenario.log = [];
              return new Response(null, { status: 204 });
            }),
          );
        }
      }

      if (subpath === "/error" && req.method === "POST") {
        const body = yield* Effect.tryPromise(() => req.json()).pipe(
          Effect.flatMap((value) => Schema.decodeUnknownEffect(ErrorControlSchema)(value)),
        );
        ctx.errorOverrides.set(`${body.method.toUpperCase()} ${body.path}`, {
          status: body.status,
          body: body.body ?? { message: "Error" },
        });
        return new Response(null, { status: 204 });
      }

      if (subpath === "/error-all" && req.method === "POST") {
        const body = yield* Effect.tryPromise(() => req.json()).pipe(
          Effect.flatMap((value) => Schema.decodeUnknownEffect(ErrorAllControlSchema)(value)),
        );
        ctx.globalErrorRef.value = {
          status: body.status,
          body: body.body ?? { message: "Error" },
        };
        return new Response(null, { status: 204 });
      }

      if (subpath === "/rate-limit" && req.method === "POST") {
        const body = yield* Effect.tryPromise(() => req.json()).pipe(
          Effect.flatMap((value) => Schema.decodeUnknownEffect(RateLimitControlSchema)(value)),
        );
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
        if (!ctx.pgMock)
          return Response.json({ message: "No PG mock configured" }, { status: 503 });
        const body = yield* Effect.tryPromise(() => req.json()).pipe(
          Effect.flatMap((value) => Schema.decodeUnknownEffect(FixtureControlSchema)(value)),
        );
        const fixturePath = join(ctx.fixturesDir, "pg", `${body.key}.json`);
        const fs = yield* FileSystem.FileSystem;
        const fixture = yield* fs.readFileString(fixturePath).pipe(
          Effect.flatMap((content) =>
            Schema.decodeEffect(Schema.fromJsonString(PgFixtureSchema))(content),
          ),
          Effect.option,
        );
        if (Option.isNone(fixture)) {
          return Response.json({ message: `PG fixture not found: ${body.key}` }, { status: 404 });
        }
        ctx.pgMock.setState({
          type: "fixture",
          fixture: {
            columns: [...fixture.value.columns],
            typeOids: fixture.value.typeOids ? [...fixture.value.typeOids] : undefined,
            rows: fixture.value.rows.map((row) => [...row]),
          },
        });
        return new Response(null, { status: 204 });
      }

      if (subpath === "/pg-error" && req.method === "POST") {
        if (!ctx.pgMock)
          return Response.json({ message: "No PG mock configured" }, { status: 503 });
        const error = yield* Effect.tryPromise(() => req.json()).pipe(
          Effect.flatMap((value) => Schema.decodeUnknownEffect(PgErrorControlSchema)(value)),
        );
        ctx.pgMock.setState({ type: "error", error });
        return new Response(null, { status: 204 });
      }

      return new Response("Not Found", { status: 404 });
    }).pipe(Effect.provide(BunServices.layer), Effect.orDie),
  );
}
