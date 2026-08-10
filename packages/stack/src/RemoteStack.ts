import { ServiceNotFoundError, ServiceReadyError, type LogEntry } from "@supabase/process-compose";
import { Effect, Layer, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { DaemonErrorResponseSchema } from "./DaemonProtocol.ts";
import { StackBuildError, StackReadinessError } from "./errors.ts";
import { Stack, StackInfoSchema } from "./Stack.ts";
import { inheritReadyOptions } from "./StackConfig.ts";
import { StackServiceState, StackServiceStatusSchema } from "./StackServiceState.ts";
import { UnixHttpClient, UnixHttpClientError } from "./UnixHttpClient.ts";
import { SERVICE_NAMES } from "./versions.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const LogEntrySchema = Schema.Struct({
  timestamp: Schema.Number,
  service: Schema.String,
  stream: Schema.Union([Schema.Literal("stdout"), Schema.Literal("stderr")]),
  line: Schema.String,
});

const StatusServiceSchema = Schema.Struct({
  name: Schema.String,
  status: StackServiceStatusSchema,
  pid: Schema.NullOr(Schema.Number),
  exitCode: Schema.NullOr(Schema.Number),
  restartCount: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
});

const StatusResponseSchema = Schema.Struct({
  info: StackInfoSchema,
  services: Schema.Array(StatusServiceSchema),
});

const StatusServiceEventSchema = Schema.fromJsonString(StatusServiceSchema);
const LogEntryEventSchema = Schema.fromJsonString(LogEntrySchema);
const decodeStatusServiceEvent = Schema.decodeUnknownSync(StatusServiceEventSchema);
const decodeLogEntryEvent = Schema.decodeUnknownSync(LogEntryEventSchema);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requestHeaders(init?: RequestInit) {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

const publicServicePath = (name: string): Effect.Effect<string, ServiceNotFoundError> => {
  const service = SERVICE_NAMES.find((candidate) => candidate === name);
  return service === undefined
    ? Effect.fail(new ServiceNotFoundError({ name }))
    : Effect.succeed(encodeURIComponent(service));
};

function makeRequest(path: string, init?: RequestInit) {
  const url = `http://localhost${path}`;
  const method = init?.method?.toUpperCase() ?? "GET";
  switch (method) {
    case "GET":
      return HttpClientRequest.get(url, { headers: requestHeaders(init) });
    case "POST":
      return HttpClientRequest.post(url, { headers: requestHeaders(init) });
    case "PUT":
      return HttpClientRequest.put(url, { headers: requestHeaders(init) });
    case "PATCH":
      return HttpClientRequest.patch(url, { headers: requestHeaders(init) });
    case "DELETE":
      return HttpClientRequest.delete(url, { headers: requestHeaders(init) });
    case "HEAD":
      return HttpClientRequest.head(url, { headers: requestHeaders(init) });
    case "OPTIONS":
      return HttpClientRequest.options(url, { headers: requestHeaders(init) });
    case "TRACE":
      return HttpClientRequest.trace(url, { headers: requestHeaders(init) });
    default:
      throw new Error(`Unsupported HTTP method: ${method}`);
  }
}

/** Make a fetch request to the daemon Unix socket. */
function unixFetch(socketPath: string, path: string, init?: RequestInit) {
  return Effect.flatMap(UnixHttpClient, (client) => client.request(socketPath, path, init));
}

function unixResponse(socketPath: string, path: string, init?: RequestInit) {
  const request = makeRequest(path, init);
  return Effect.map(unixFetch(socketPath, path, init), (response) =>
    HttpClientResponse.fromWeb(request, response),
  );
}

/** Preserve daemon RPC identity when an HTTP status or body cannot be decoded. */
function dieOnNonOkStatus<A>(
  socketPath: string,
  path: string,
  effect: Effect.Effect<A, HttpClientError.HttpClientError>,
) {
  return effect.pipe(
    Effect.mapError(
      (cause) => new UnixHttpClientError({ socketPath, path, cause, reason: "status" }),
    ),
    Effect.orDie,
  );
}

function dieOnBodyDecodeError<A, E, R>(
  socketPath: string,
  path: string,
  effect: Effect.Effect<A, E, R>,
) {
  return effect.pipe(
    Effect.mapError(
      (cause) => new UnixHttpClientError({ socketPath, path, cause, reason: "protocol" }),
    ),
    Effect.orDie,
  );
}

function withAbortSignal<A, E, R>(
  effect: (signal: AbortSignal) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    (controller) => effect(controller.signal),
    (controller) => Effect.sync(() => controller.abort()),
  );
}

const failDaemonResponse = (
  socketPath: string,
  path: string,
  response: HttpClientResponse.HttpClientResponse,
  fallbackName: string,
): Effect.Effect<
  never,
  ServiceNotFoundError | ServiceReadyError | StackBuildError | StackReadinessError
> =>
  Effect.gen(function* () {
    const body = yield* dieOnBodyDecodeError(
      socketPath,
      path,
      HttpClientResponse.schemaBodyJson(DaemonErrorResponseSchema)(response),
    );
    switch (body.code) {
      case "SERVICE_NOT_FOUND":
        return yield* new ServiceNotFoundError({ name: body.service ?? fallbackName });
      case "SERVICE_NOT_READY":
        return yield* new ServiceReadyError({
          name: body.service ?? fallbackName,
          reason: body.error,
          ...(body.exitCode === undefined ? {} : { exitCode: body.exitCode }),
        });
      case "STACK_BUILD_ERROR":
        return yield* new StackBuildError({
          detail: body.error,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        });
      case "STACK_READINESS_TIMEOUT":
        return yield* new StackReadinessError({
          target: body.service ?? fallbackName,
          timeoutMs: body.timeoutMs ?? 0,
          detail: body.error,
        });
    }
  });

const expectDaemonOk = (
  socketPath: string,
  path: string,
  response: HttpClientResponse.HttpClientResponse,
  fallbackName: string,
): Effect.Effect<
  void,
  ServiceNotFoundError | ServiceReadyError | StackBuildError | StackReadinessError
> =>
  response.status >= 200 && response.status < 300
    ? Effect.void
    : failDaemonResponse(socketPath, path, response, fallbackName);

/** Fetch JSON from the daemon, dying on HTTP errors. */
function fetchStatus(socketPath: string, path: string, method = "GET") {
  return Effect.gen(function* () {
    const response = yield* unixResponse(socketPath, path, { method });
    const okResponse = yield* dieOnNonOkStatus(
      socketPath,
      path,
      HttpClientResponse.filterStatusOk(response),
    );
    return yield* dieOnBodyDecodeError(
      socketPath,
      path,
      HttpClientResponse.schemaBodyJson(StatusResponseSchema)(okResponse),
    );
  });
}

function fetchLogEntries(socketPath: string, path: string) {
  return Effect.gen(function* () {
    const response = yield* unixResponse(socketPath, path);
    const okResponse = yield* dieOnNonOkStatus(
      socketPath,
      path,
      HttpClientResponse.filterStatusOk(response),
    );
    return yield* dieOnBodyDecodeError(
      socketPath,
      path,
      HttpClientResponse.schemaBodyJson(Schema.Array(LogEntrySchema))(okResponse),
    );
  });
}

function encodeSearchParams(
  params: Record<string, string | number | ReadonlyArray<string> | undefined>,
): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        searchParams.append(key, item);
      }
      continue;
    }
    searchParams.set(key, String(value));
  }
  const query = searchParams.toString();
  return query.length > 0 ? `?${query}` : "";
}

/** Convert a ReadableStream SSE body into an Effect Stream of parsed events. */
function sseStream<A>(socketPath: string, path: string, parse: (data: string) => A) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const controller = new AbortController();
      const response = yield* unixFetch(socketPath, path, { signal: controller.signal });
      if (!response.ok) {
        return yield* new UnixHttpClientError({
          socketPath,
          path,
          cause: new Error(`SSE request failed: ${response.status}`),
          reason: "status",
        });
      }
      const body = response.body;
      if (body === null) {
        return yield* new UnixHttpClientError({
          socketPath,
          path,
          cause: new Error("SSE response body is missing"),
          reason: "protocol",
        });
      }

      // State shared across chunks — parser is stateful, accumulates partial events
      const collected: A[] = [];
      const parser = Sse.makeParser((event) => {
        if (event._tag === "Event") {
          collected.push(parse(event.data));
        }
      });

      return Stream.fromReadableStream({
        evaluate: () => body,
        onError: (cause) =>
          new UnixHttpClientError({ socketPath, path, cause, reason: "transport" }),
      }).pipe(
        Stream.mapEffect((chunk: Uint8Array) =>
          Effect.try({
            try: () => {
              collected.length = 0;
              parser.feed(new TextDecoder().decode(chunk, { stream: true }));
              return Array.from(collected);
            },
            catch: (cause) =>
              new UnixHttpClientError({ socketPath, path, cause, reason: "protocol" }),
          }),
        ),
        Stream.flatMap(Stream.fromIterable),
        Stream.ensuring(Effect.sync(() => controller.abort())),
      );
    }),
  );
}

/** Deserialize a plain JSON object into a ServiceState Data.Class instance. */
function toServiceState(
  raw: (typeof StatusResponseSchema.Type)["services"][number],
): StackServiceState {
  return new StackServiceState({
    name: raw.name,
    status: raw.status,
    pid: raw.pid,
    exitCode: raw.exitCode,
    restartCount: raw.restartCount,
    startedAt: raw.startedAt,
    error: raw.error,
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * RemoteStack implements the Stack interface over HTTP to a daemon
 * running on a Unix socket. This allows the CLI to transparently switch
 * between foreground (in-process) and detached (daemon) modes.
 */
export const RemoteStack = {
  layer: (socketPath: string): Layer.Layer<Stack, never, UnixHttpClient> =>
    Layer.effect(
      Stack,
      Effect.gen(function* () {
        const unixHttpClient = yield* UnixHttpClient;
        const unixHttpClientLayer = Layer.succeed(UnixHttpClient, unixHttpClient);
        const withUnixHttpClient = <A, E, R>(
          effect: Effect.Effect<A, E | UnixHttpClientError, R | UnixHttpClient>,
        ) =>
          effect.pipe(
            Effect.provide(unixHttpClientLayer),
            Effect.catchTag("UnixHttpClientError", (error) => Effect.die(error)),
          );
        const withUnixHttpClientStream = <A, E, R>(
          stream: Stream.Stream<A, E | UnixHttpClientError, R | UnixHttpClient>,
        ) =>
          stream.pipe(
            Stream.provide(unixHttpClientLayer),
            Stream.catchTag("UnixHttpClientError", (error) => Stream.die(error)),
          );

        return {
          getInfo: () =>
            withUnixHttpClient(Effect.map(fetchStatus(socketPath, "/status"), (res) => res.info)),

          start: () =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const path = "/start";
                const response = yield* unixResponse(socketPath, path, { method: "POST" });
                yield* expectDaemonOk(socketPath, path, response, "stack").pipe(
                  Effect.catchTag("ServiceNotFoundError", (error) => Effect.die(error)),
                );
              }),
            ),

          stop: () =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const path = "/stop";
                const response = yield* unixResponse(socketPath, path, { method: "POST" });
                yield* dieOnNonOkStatus(
                  socketPath,
                  path,
                  HttpClientResponse.filterStatusOk(response),
                );
              }),
            ),

          dispose: () =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const path = "/stop";
                const response = yield* unixResponse(socketPath, path, { method: "POST" });
                yield* dieOnNonOkStatus(
                  socketPath,
                  path,
                  HttpClientResponse.filterStatusOk(response),
                );
              }),
            ),

          startService: (name: string) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const servicePath = yield* publicServicePath(name);
                const path = `/services/${servicePath}/start`;
                const response = yield* unixResponse(socketPath, path, {
                  method: "POST",
                });
                yield* expectDaemonOk(socketPath, path, response, name);
              }),
            ),

          stopService: (name: string) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const servicePath = yield* publicServicePath(name);
                const path = `/services/${servicePath}/stop`;
                const response = yield* unixResponse(socketPath, path, {
                  method: "POST",
                });
                yield* expectDaemonOk(socketPath, path, response, name).pipe(
                  Effect.catchTag("ServiceReadyError", (error) => Effect.die(error)),
                  Effect.catchTag("StackReadinessError", (error) => Effect.die(error)),
                );
              }),
            ),

          restartService: (name: string) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const servicePath = yield* publicServicePath(name);
                const path = `/services/${servicePath}/restart`;
                const response = yield* unixResponse(socketPath, path, {
                  method: "POST",
                });
                yield* expectDaemonOk(socketPath, path, response, name);
              }),
            ),

          reloadFunctions: (opts) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const path = "/functions/reload";
                const response = yield* unixResponse(socketPath, path, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(opts ?? {}),
                });
                yield* expectDaemonOk(socketPath, path, response, "edge-runtime");
              }),
            ),

          reloadEdgeRuntime: (opts) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const path = "/edge-runtime/reload";
                const response = yield* unixResponse(socketPath, path, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(opts),
                });
                yield* expectDaemonOk(socketPath, path, response, "edge-runtime");
              }),
            ),

          getState: (name: string) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const { services } = yield* fetchStatus(socketPath, "/status");
                const match = services.find((s) => s.name === name);
                if (!match) {
                  return yield* new ServiceNotFoundError({ name });
                }
                return toServiceState(match);
              }),
            ),

          getAllStates: () =>
            withUnixHttpClient(
              Effect.map(fetchStatus(socketPath, "/status"), (res) =>
                res.services.map(toServiceState),
              ),
            ),

          stateChanges: (name: string) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                // Verify the service exists first
                const { services } = yield* fetchStatus(socketPath, "/status");
                if (!services.some((s) => s.name === name)) {
                  return yield* new ServiceNotFoundError({ name });
                }
                return withUnixHttpClientStream(
                  sseStream(socketPath, "/status/stream", (data) => {
                    const raw = decodeStatusServiceEvent(data);
                    return toServiceState(raw);
                  }).pipe(Stream.filter((s) => s.name === name)),
                );
              }),
            ),

          allStateChanges: () =>
            withUnixHttpClientStream(
              sseStream(socketPath, "/status/stream", (data) => {
                const raw = decodeStatusServiceEvent(data);
                return toServiceState(raw);
              }),
            ),

          waitReady: (name, opts) =>
            withUnixHttpClient(
              withAbortSignal((signal) =>
                Effect.gen(function* () {
                  const servicePath = yield* publicServicePath(name);
                  const path = `/services/${servicePath}/ready`;
                  const response = yield* unixResponse(socketPath, path, {
                    method: "POST",
                    signal,
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(opts ?? inheritReadyOptions),
                  });
                  yield* expectDaemonOk(socketPath, path, response, name);
                }),
              ),
            ),

          waitAllReady: (opts) =>
            withUnixHttpClient(
              withAbortSignal((signal) =>
                Effect.gen(function* () {
                  const path = "/ready";
                  const response = yield* unixResponse(socketPath, path, {
                    method: "POST",
                    signal,
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(opts ?? inheritReadyOptions),
                  });
                  yield* expectDaemonOk(socketPath, path, response, "stack").pipe(
                    Effect.catchTag("ServiceNotFoundError", (error) => Effect.die(error)),
                  );
                }),
              ),
            ),

          subscribeLogs: (name: string) =>
            withUnixHttpClientStream(
              sseStream<LogEntry>(socketPath, `/logs/${encodeURIComponent(name)}`, (data) =>
                decodeLogEntryEvent(data),
              ),
            ),

          subscribeAllLogs: (services) => {
            const query = encodeSearchParams({ service: services });
            return withUnixHttpClientStream(
              sseStream<LogEntry>(socketPath, `/logs${query}`, (data) => decodeLogEntryEvent(data)),
            );
          },

          logHistory: (name: string, limit?: number) => {
            const query = limit !== undefined ? `?limit=${limit}` : "";
            return withUnixHttpClient(
              fetchLogEntries(socketPath, `/logs/${encodeURIComponent(name)}/history${query}`),
            );
          },

          logHistoryAll: (limit?: number, services?: ReadonlyArray<string>) => {
            const query = encodeSearchParams({ limit, service: services });
            return withUnixHttpClient(fetchLogEntries(socketPath, `/logs/history${query}`));
          },
        };
      }),
    ),
};
