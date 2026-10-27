import { URL } from "node:url";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { NodeHttpClient } from "@effect/platform-node";
import {
  Clock,
  Console,
  Context,
  Data,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  LayerMap,
  Option,
  Path,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpMethod,
} from "effect/http";
import type {
  FixtureEntry,
  FixtureRequest,
  FixtureResponse,
  FixtureStore,
} from "./fixture-loader.ts";
import { loadFixtures, loadScenario, pathExists } from "./fixture-loader.ts";
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

/** The replay server could not start: record mode without a staging URL, or no listener. */
class ReplayServerStartError extends Data.TaggedError("ReplayServerStartError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** An incoming request or control payload body could not be read. */
class RequestBodyError extends Data.TaggedError("RequestBodyError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The record-mode proxy to staging failed before a response arrived. */
class StagingProxyError extends Data.TaggedError("StagingProxyError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A recorded interaction could not be serialized into its fixture files. */
class FixtureWriteError extends Data.TaggedError("FixtureWriteError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The record-mode Docker socket exchange failed; messages are the `node:http` errors. */
class DockerSocketError extends Data.TaggedError("DockerSocketError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/* `JSON.stringify`/`JSON.parse` through Schema; fixture files keep their 2-space indentation. */
const JsonText = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeEffect(JsonText);
const decodeJson = Schema.decodeEffect(JsonText);
const encodeFixtureJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

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
  /** Proxy to staging and record fixtures instead of replaying them. */
  record: boolean;
  /** Staging Management API base URL; required when recording. */
  stagingUrl: string | undefined;
}

/* The Docker leg uses node:http because Bun's fetch sorts response headers, while fixtures record them in arrival order. */
class DockerClients extends LayerMap.Service<DockerClients>()("cli-e2e/DockerClients", {
  lookup: (socketPath: string) => {
    /* AgentOptions does not declare socketPath, but the pinned Bun's node:http reads it from
       the agent options; Bun 1.3 ignores it and connects to localhost:80. */
    const agentOptions = { keepAlive: true, socketPath };
    return Layer.fresh(NodeHttpClient.layerNodeHttpNoAgent).pipe(
      Layer.provide(NodeHttpClient.layerAgentOptions(agentOptions)),
    );
  },
  idleTimeToLive: Duration.infinity,
}) {}

const serverLayer = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  FetchHttpClient.layer,
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
  DockerClients.layer,
);

/** Runs the replay server until the caller's scope closes, which stops it and releases its layer. */
export const startReplayServer = (options: ReplayServerOptions) =>
  Layer.build(serverLayer).pipe(
    Effect.flatMap((context) => makeReplayServer(options).pipe(Effect.provideContext(context))),
  );

const makeReplayServer = Effect.fn("ReplayServer.start")(function* (options: ReplayServerOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isRecord = options.record;
  const stagingUrl = options.stagingUrl;

  if (isRecord && !stagingUrl) {
    return yield* new ReplayServerStartError({
      message: "RECORD=true requires SUPABASE_STAGING_URL to be set",
    });
  }

  // In record mode, wipe both fixture stores before serving any traffic, so the
  // recording session repopulates only what the running tests exercise and any
  // orphan from a prior session is dropped.
  if (isRecord) {
    yield* fs.remove(path.join(options.fixturesDir, "recorded"), { recursive: true, force: true });
    yield* fs.remove(path.join(options.fixturesDir, "scenarios"), { recursive: true, force: true });
  }

  const store: FixtureStore = isRecord ? new Map() : yield* loadFixtures(options.fixturesDir);

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
  /* Fixture and scenario writes run one at a time, as the synchronous writes they replaced did. */
  const recordLock = yield* Semaphore.make(1);
  /* Docker exchanges outlive the handler fiber that forked them; serverScope owns them until the server stops. */
  const serverScope = yield* Scope.fork(yield* Scope.Scope);
  const services = Context.add(
    yield* Effect.context<
      FileSystem.FileSystem | Path.Path | HttpClient.HttpClient | DockerClients
    >(),
    Scope.Scope,
    serverScope,
  );

  function overrideKey(method: string, path: string): string {
    return `${method.toUpperCase()} ${path}`;
  }

  const handleRequest = Effect.fnUntraced(function* (req: Request) {
    const url = new URL(req.url);

    // Control plane — not forwarded to CLI or staging
    if (url.pathname.startsWith("/_ctrl/")) {
      return yield* handleControl(req, url, {
        requestLog,
        counters,
        errorOverrides,
        rateLimitOverrides,
        scenario,
        globalErrorRef,
        isRecord,
        fixturesDir: options.fixturesDir,
        pgMock: options.pgMock,
        recordLock,
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
      // not JSON — leave as null
      requestBody = yield* readJson(req).pipe(Effect.orElseSucceed(() => null));
    } else {
      rawBody = req.body;
    }

    requestLog.push({
      method,
      pathname,
      query,
      headers: requestHeaders,
      body: requestBody,
      timestamp: DateTime.formatIso(yield* DateTime.now),
    });

    // Global error override — returned for all API requests regardless of endpoint.
    if (globalErrorRef.value) {
      return injectedErrorResponse(globalErrorRef.value);
    }

    // Per-endpoint error overrides
    const errKey = overrideKey(method, pathname);
    const errorOverride = errorOverrides.get(errKey);
    if (errorOverride) {
      return injectedErrorResponse(errorOverride);
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
      return yield* proxyAndRecord(
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
        recordLock,
        storageProxyUrl,
        storageProxyAuth,
        dockerProxySocketPath,
      );
    }

    // Replay mode: scenario takes priority for matching requests; out-of-band
    // requests (e.g. post-command telemetry calls) fall through to the
    // per-endpoint fixture store.
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
  });

  /* Bun's graceful stop drains in-flight responses before serverScope closes. */
  const server = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.serve({
          port: options.port ?? 0,
          fetch: (req: Request) => Effect.runPromiseWith(services)(handleRequest(req)),
        }),
      catch: (cause) => new ReplayServerStartError({ message: causeMessage(cause), cause }),
    }),
    (server) => Effect.promise(() => server.stop()),
  );

  const port = server.port ?? 0;
  const serverUrl = `http://127.0.0.1:${port}`;

  const handle: ReplayServerHandle = {
    url: serverUrl,
    port,
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
  return handle;
});

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

function stripResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const responseHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) responseHeaders[k] = v;
  }
  return responseHeaders;
}

const proxyAndRecord = Effect.fn("ReplayServer.proxyAndRecord")(function* (
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
  recordLock: Semaphore.Semaphore,
  storageProxyUrl?: string,
  storageProxyAuth?: string,
  dockerProxySocketPath?: string,
) {
  const isStoragePath = pathname.startsWith("/storage/v1/");
  // Docker versioned API paths start with /v1. (decimal), not /v1/ (slash, the
  // management API). /_ping is the Docker health-check endpoint (no version prefix).
  const isDockerPath = pathname.startsWith("/v1.") || pathname === "/_ping";

  const FORWARD_HEADERS = new Set(["authorization", "content-type", "accept", "user-agent"]);
  const upstreamHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(requestHeaders)) {
    if (FORWARD_HEADERS.has(k.toLowerCase())) upstreamHeaders[k] = v;
  }

  if (isDockerPath && dockerProxySocketPath) {
    // Stream the response back to the caller immediately.  Recording happens
    // asynchronously after the body has fully drained — long-running streaming
    // endpoints (image pull progress, container logs) are not blocked on it.
    // The stream ends for the caller only once the recording is written.
    const dockerResult = yield* proxyToDockerSocket(
      dockerProxySocketPath,
      method,
      pathname,
      query,
      upstreamHeaders,
      requestBody,
      rawBody,
      (responseStatus, headers, body) =>
        recordDockerInteraction({
          body,
          method,
          pathname,
          query,
          requestHeaders,
          requestBody,
          responseStatus,
          responseHeaders: stripResponseHeaders(headers),
          fixturesDir,
          recordedKeys,
          scenario,
          recordLock,
        }),
    );

    return new Response(dockerResult.stream, {
      status: dockerResult.status,
      headers: stripResponseHeaders(dockerResult.headers),
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
    return yield* new StagingProxyError({ message: `Unsupported HTTP method: ${method}` });
  }
  const upstreamBody =
    method !== "GET" && method !== "HEAD"
      ? requestBody != null
        ? yield* encodeJson(requestBody).pipe(
            Effect.mapError((cause) => new StagingProxyError({ message: cause.message, cause })),
          )
        : (rawBody ?? undefined)
      : undefined;
  const upstreamRes = yield* HttpClient.execute(
    HttpClientRequest.make(method)(targetUrl.toString(), {
      headers: upstreamHeaders,
      body:
        upstreamBody === undefined
          ? undefined
          : HttpBody.raw(upstreamBody, { contentType: upstreamHeaders["content-type"] }),
    }),
  ).pipe(
    Effect.mapError((error) => {
      const cause = "cause" in error.reason ? error.reason.cause : error;
      return new StagingProxyError({ message: causeMessage(cause), cause });
    }),
  );

  const responseBody = yield* upstreamRes.json.pipe(Effect.orElseSucceed(() => null));
  const responseHeaders = stripResponseHeaders(upstreamRes.headers);
  const upstreamStatus = upstreamRes.status;
  yield* Effect.annotateCurrentSpan("http.response.status_code", upstreamStatus);
  const responseContentType = upstreamRes.headers["content-type"] ?? "application/json";

  yield* recordFixture({
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
    recordLock,
  });

  return buildApiResponse(responseBody, upstreamStatus, {
    ...responseHeaders,
    "content-type": responseContentType,
  });
});

/** Record a Docker interaction once its streamed body has fully drained.  Errors
 *  are logged but do not surface — recording is best-effort and must not affect
 *  the response the caller already received. */
const recordDockerInteraction = Effect.fnUntraced(function* (params: {
  body: Effect.Effect<Buffer, DockerSocketError>;
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
  recordLock: Semaphore.Semaphore;
}) {
  const captured = yield* params.body.pipe(
    Effect.tapError((err) =>
      Console.error(
        `[replay-server] failed to capture Docker body for ${params.method} ${params.pathname}:`,
        err,
      ),
    ),
    Effect.option,
  );
  if (Option.isNone(captured)) return;
  const body = captured.value;

  let responseBody: unknown;
  if (body.length === 0) {
    responseBody = null;
  } else {
    // Non-JSON or chunked NDJSON (image pull progress, container log frames,
    // event streams) — preserve as a base64 envelope so replay can return the
    // bytes verbatim instead of silently dropping them.
    responseBody = yield* decodeJson(body.toString("utf8")).pipe(
      Effect.orElseSucceed(() => ({ __type: "raw", base64: body.toString("base64") })),
    );
  }

  yield* recordFixture({
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
    recordLock: params.recordLock,
  }).pipe(
    Effect.catch((err) =>
      Console.error(
        `[replay-server] failed to record Docker interaction for ${params.method} ${params.pathname}:`,
        err,
      ),
    ),
  );
});

/* Once the record lock is held, the write finishes even if the server stops mid-recording. */
const recordFixture = (params: {
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
  recordLock: Semaphore.Semaphore;
}) => params.recordLock.withPermit(writeFixture(params).pipe(Effect.uninterruptible));

const fixtureWriteError = (cause: Schema.SchemaError) =>
  new FixtureWriteError({ message: cause.message, cause });

const writeFixture = Effect.fn("ReplayServer.writeFixture")(function* (params: {
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
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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
  }).pipe(Effect.mapError(fixtureWriteError));
  const { output } = applyPlaceholders(rawPair);
  const normalized = (yield* decodeJson(output).pipe(Effect.mapError(fixtureWriteError))) as {
    request: FixtureRequest;
    response: FixtureResponse;
  };
  // Normalized so comparison against incoming paths (normalized the same way) is idempotent.
  normalized.request.path = normalizeUrlPath(params.pathname);

  const key = fixtureKey(params.method, params.pathname);
  const keyDir = path.join(params.fixturesDir, "recorded", key);

  if (!params.recordedKeys.has(key)) {
    params.recordedKeys.add(key);
    if (yield* pathExists(fs, keyDir)) {
      for (const file of yield* fs.readDirectory(keyDir)) {
        yield* fs.remove(path.join(keyDir, file));
      }
    }
  }

  yield* fs.makeDirectory(keyDir, { recursive: true });

  const nextIndex = yield* nextFixtureIndex(keyDir);
  // Beyond the cap, the proxied response is still returned but no longer persisted.
  if (nextIndex <= MAX_FIXTURE_ENTRIES) {
    const indexStr = nextIndex === 1 ? "default" : String(nextIndex);

    yield* fs.writeFileString(
      path.join(keyDir, `${indexStr}.request.json`),
      yield* encodeFixtureJson(normalized.request).pipe(Effect.mapError(fixtureWriteError)),
    );
    yield* fs.writeFileString(
      path.join(keyDir, `${indexStr}.response.json`),
      yield* encodeFixtureJson(normalized.response).pipe(Effect.mapError(fixtureWriteError)),
    );
  }

  if (params.scenario.name !== null) {
    params.scenario.log.push({ request: normalized.request, response: normalized.response });
    yield* writeScenarioInteractions(params.fixturesDir, params.scenario.name, params.scenario.log);
  }
});

interface DockerProxyResult {
  status: number;
  headers: Record<string, string>;
  /** Streamed back to the caller — chunks arrive as Docker emits them, so
   *  long-running streaming endpoints (image pull progress, container logs,
   *  events) are not blocked on the full upstream body. */
  stream: ReadableStream<Uint8Array>;
}

/** Receives the full concatenated body (or its failure) once the upstream
 *  stream ends.  Used by `proxyAndRecord` to write the fixture *after* the
 *  body has drained to the caller and before the caller's stream ends. */
type DockerBodyHandler<R> = (
  status: number,
  headers: Record<string, string>,
  body: Exit.Exit<Buffer, DockerSocketError>,
) => Effect.Effect<void, never, R>;

/** Idle timeout: abort if the upstream socket goes silent for this long. Only
 *  kills truly stuck connections — a slow but still-active operation (e.g. a
 *  first-time image pull) stays alive as long as it keeps emitting progress. */
const DOCKER_SOCKET_IDLE_TIMEOUT_MS = 60_000;

const dockerFailure = (error: HttpClientError.HttpClientError) => {
  const cause = "cause" in error.reason ? error.reason.cause : error;
  return new DockerSocketError({ message: causeMessage(cause), cause });
};

/* The error `node:http` raised on a response body cut short by an idle timeout or the
   caller going away. */
const abortedError = () => new DockerSocketError({ message: "aborted" });

const proxyToDockerSocket = Effect.fn("ReplayServer.proxyToDockerSocket")(function* <R>(
  socketPath: string,
  method: string,
  pathname: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  requestBody: unknown,
  rawBody: ReadableStream<Uint8Array> | null,
  onBody: DockerBodyHandler<R>,
) {
  const qStr = new URLSearchParams(query).toString();
  const path = qStr ? `${pathname}?${qStr}` : pathname;

  let bodyBuf: Buffer | undefined;
  if (requestBody != null) {
    const json = yield* encodeJson(requestBody).pipe(
      Effect.mapError((cause) => new DockerSocketError({ message: cause.message, cause })),
    );
    bodyBuf = Buffer.from(json, "utf8");
  } else if (rawBody != null) {
    const ab = yield* Effect.tryPromise({
      try: () => new Response(rawBody).arrayBuffer(),
      catch: (cause) => new RequestBodyError({ message: causeMessage(cause), cause }),
    });
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
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) reqHeaders[k] = v;
  }

  if (!HttpMethod.isHttpMethod(method)) {
    return yield* new DockerSocketError({ message: `Unsupported HTTP method: ${method}` });
  }
  const response = yield* HttpClient.execute(
    HttpClientRequest.make(method)(`http://localhost${path}`, {
      headers: reqHeaders,
      body:
        bodyBuf === undefined
          ? undefined
          : HttpBody.raw(bodyBuf, {
              contentType: reqHeaders["content-type"],
              contentLength: bodyBuf.length,
            }),
    }),
  ).pipe(Effect.provide(DockerClients.get(socketPath)), Effect.mapError(dockerFailure));
  yield* Effect.annotateCurrentSpan("http.response.status_code", response.status);

  const chunks: Uint8Array[] = [];
  let lastActivity = yield* Clock.currentTimeMillis;
  const settled = yield* Deferred.make<void, DockerSocketError>();
  let cancelled = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
      Deferred.doneUnsafe(settled, Exit.fail(abortedError()));
    },
  });
  const emit = Effect.fnUntraced(function* (chunk: Uint8Array) {
    lastActivity = yield* Clock.currentTimeMillis;
    chunks.push(chunk);
    if (!cancelled) controller?.enqueue(new Uint8Array(chunk));
  });

  const relay = Effect.gen(function* () {
    yield* Stream.runForEach(response.stream, emit).pipe(
      Effect.mapError(dockerFailure),
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(settled, exit)),
      Effect.forkScoped,
    );
    yield* Clock.currentTimeMillis.pipe(
      Effect.map((now) => now - lastActivity > DOCKER_SOCKET_IDLE_TIMEOUT_MS),
      Effect.repeat({ schedule: Schedule.fixed("5 seconds"), until: (idle) => idle }),
      Effect.andThen(Deferred.fail(settled, abortedError())),
      Effect.forkScoped,
    );
    yield* Deferred.await(settled).pipe(
      Effect.matchEffect({
        onSuccess: () =>
          onBody(response.status, response.headers, Exit.succeed(Buffer.concat(chunks))).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (!cancelled) controller?.close();
              }),
            ),
          ),
        onFailure: (error) =>
          Effect.sync(() => controller?.error(error)).pipe(
            Effect.andThen(onBody(response.status, response.headers, Exit.fail(error))),
          ),
      }),
    );
  }).pipe(Effect.scoped);
  const relayFiber = yield* Effect.forkScoped(relay);
  /* node:http ends a bodiless response before the caller sees it, so it is recorded and closed first. */
  if (method === "HEAD" || response.status === 204 || response.status === 304) {
    yield* Fiber.await(relayFiber);
  }

  return { status: response.status, headers: response.headers, stream } satisfies DockerProxyResult;
});

const writeScenarioInteractions = Effect.fn("ReplayServer.writeScenarioInteractions")(function* (
  fixturesDir: string,
  scenarioName: string,
  interactions: Array<{ request: FixtureRequest; response: FixtureResponse }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scenarioDir = path.join(fixturesDir, "scenarios", scenarioName);
  yield* fs.makeDirectory(scenarioDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(scenarioDir, "interactions.json"),
    yield* encodeFixtureJson(interactions).pipe(Effect.mapError(fixtureWriteError)),
  );
});

const nextFixtureIndex = Effect.fnUntraced(function* (keyDir: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* pathExists(fs, keyDir))) return 1;
  const files = yield* fs.readDirectory(keyDir);
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
});

/** Injected 429/5xx responses ask the typed client to retry at once so tests skip its backoff. */
function injectedErrorResponse(error: { status: number; body: unknown }): Response {
  const retryable = error.status === 429 || error.status >= 500;
  return Response.json(error.body, {
    status: error.status,
    ...(retryable ? { headers: { "Retry-After": "0" } } : {}),
  });
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
  return new Response(JSON.stringify(body), {
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
  recordLock: Semaphore.Semaphore;
}

const readJson = (req: Request) =>
  Effect.tryPromise({
    try: () => req.json(),
    catch: (cause) => new RequestBodyError({ message: causeMessage(cause), cause }),
  });

const handleControl = Effect.fnUntraced(function* (req: Request, url: URL, ctx: ControlContext) {
  const path = yield* Path.Path;
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
      const { name } = (yield* readJson(req)) as { name: string };

      return yield* ctx.recordLock.withPermit(
        Effect.gen(function* () {
          if (!ctx.isRecord) {
            const interactions = yield* loadScenario(path.join(ctx.fixturesDir, "scenarios"), name);
            if (!interactions) {
              return Response.json(
                { message: `Missing scenario: "${name}" — re-record with RECORD=true` },
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
        }),
      );
    }

    if (req.method === "DELETE") {
      return yield* ctx.recordLock.withPermit(
        Effect.gen(function* () {
          // Flush interactions.json even when empty, so a test that hits a global
          // error before any API call still gets a scenario file.
          if (ctx.isRecord && ctx.scenario.name !== null) {
            yield* writeScenarioInteractions(ctx.fixturesDir, ctx.scenario.name, ctx.scenario.log);
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
    const body = (yield* readJson(req)) as {
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
    const body = (yield* readJson(req)) as { status: number; body?: unknown };
    ctx.globalErrorRef.value = {
      status: body.status,
      body: body.body ?? { message: "Error" },
    };
    return new Response(null, { status: 204 });
  }

  if (subpath === "/rate-limit" && req.method === "POST") {
    const body = (yield* readJson(req)) as {
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
      return Response.json(
        { message: "No PG mock configured" },
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    const { key } = (yield* readJson(req)) as { key: string };
    const fixturePath = path.join(ctx.fixturesDir, "pg", `${key}.json`);
    const fixture = yield* Effect.tryPromise(() => Bun.file(fixturePath).json()).pipe(
      Effect.option,
    );
    if (Option.isNone(fixture)) {
      return Response.json(
        { message: `PG fixture not found: ${key}` },
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }
    ctx.pgMock.setState({ type: "fixture", fixture: fixture.value as PgFixture });
    return new Response(null, { status: 204 });
  }

  if (subpath === "/pg-error" && req.method === "POST") {
    if (!ctx.pgMock) {
      return Response.json(
        { message: "No PG mock configured" },
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    const error = (yield* readJson(req)) as { code: string; message: string; severity?: string };
    ctx.pgMock.setState({ type: "error", error });
    return new Response(null, { status: 204 });
  }

  return new Response("Not Found", { status: 404 });
});
