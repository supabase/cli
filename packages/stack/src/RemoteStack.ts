import { ServiceNotFoundError, ServiceReadyError, type LogEntry } from "@supabase/process-compose";
import { Effect, Layer, Predicate, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { DaemonErrorResponseSchema } from "./DaemonProtocol.ts";
import { StackBuildError, StackNotRunningError, StackReadinessError } from "./errors.ts";
import { Stack, StackInfoSchema } from "./Stack.ts";
import { inheritReadyOptions } from "./StackConfig.ts";
import { StackServiceState, StackServiceStatusSchema } from "./StackServiceState.ts";
import { HttpTransportClient, HttpTransportClientError } from "./HttpTransportClient.ts";
import type { ControlEndpoint } from "./managed/control.ts";
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

const decodeStatusServiceEvent = (
  endpoint: ControlEndpoint,
  path: string,
  data: string,
): Effect.Effect<StackServiceState, HttpTransportClientError> =>
  Schema.decodeUnknownEffect(StatusServiceEventSchema)(data).pipe(
    Effect.map(toServiceState),
    Effect.mapError(
      (cause) => new HttpTransportClientError({ endpoint, path, cause, reason: "protocol" }),
    ),
  );

const decodeLogEntryEvent = (
  endpoint: ControlEndpoint,
  path: string,
  data: string,
): Effect.Effect<LogEntry, HttpTransportClientError> =>
  Schema.decodeUnknownEffect(LogEntryEventSchema)(data).pipe(
    Effect.mapError(
      (cause) => new HttpTransportClientError({ endpoint, path, cause, reason: "protocol" }),
    ),
  );

function makeRequest(
  endpoint: ControlEndpoint,
  path: string,
  init?: RequestInit,
): Effect.Effect<HttpClientRequest.HttpClientRequest, HttpTransportClientError> {
  const url = `http://localhost${path}`;
  const method = init?.method?.toUpperCase() ?? "GET";
  switch (method) {
    case "GET":
      return Effect.succeed(HttpClientRequest.get(url, { headers: requestHeaders(init) }));
    case "POST":
      return Effect.succeed(HttpClientRequest.post(url, { headers: requestHeaders(init) }));
    case "PUT":
      return Effect.succeed(HttpClientRequest.put(url, { headers: requestHeaders(init) }));
    case "PATCH":
      return Effect.succeed(HttpClientRequest.patch(url, { headers: requestHeaders(init) }));
    case "DELETE":
      return Effect.succeed(HttpClientRequest.delete(url, { headers: requestHeaders(init) }));
    case "HEAD":
      return Effect.succeed(HttpClientRequest.head(url, { headers: requestHeaders(init) }));
    case "OPTIONS":
      return Effect.succeed(HttpClientRequest.options(url, { headers: requestHeaders(init) }));
    case "TRACE":
      return Effect.succeed(HttpClientRequest.trace(url, { headers: requestHeaders(init) }));
    default:
      return Effect.fail(
        new HttpTransportClientError({
          endpoint,
          path,
          cause: `Unsupported HTTP method: ${method}`,
          reason: "protocol",
        }),
      );
  }
}

/** Make a fetch request to the daemon control endpoint. */
function httpFetch(endpoint: ControlEndpoint, path: string, init?: RequestInit) {
  return Effect.flatMap(HttpTransportClient, (client) => client.request(endpoint, path, init));
}

function httpResponse(endpoint: ControlEndpoint, path: string, init?: RequestInit) {
  return Effect.gen(function* () {
    const request = yield* makeRequest(endpoint, path, init);
    const response = yield* httpFetch(endpoint, path, init);
    return HttpClientResponse.fromWeb(request, response);
  });
}

/** Preserve daemon RPC identity when an HTTP status or body cannot be decoded. */
function dieOnNonOkStatus<A>(
  endpoint: ControlEndpoint,
  path: string,
  effect: Effect.Effect<A, HttpClientError.HttpClientError>,
) {
  return effect.pipe(
    Effect.mapError(
      (cause) => new HttpTransportClientError({ endpoint, path, cause, reason: "status" }),
    ),
    Effect.orDie,
  );
}

function dieOnBodyDecodeError<A, E, R>(
  endpoint: ControlEndpoint,
  path: string,
  effect: Effect.Effect<A, E, R>,
) {
  return effect.pipe(
    Effect.mapError(
      (cause) => new HttpTransportClientError({ endpoint, path, cause, reason: "protocol" }),
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
  endpoint: ControlEndpoint,
  path: string,
  response: HttpClientResponse.HttpClientResponse,
  fallbackName: string,
): Effect.Effect<
  never,
  | ServiceNotFoundError
  | ServiceReadyError
  | StackBuildError
  | StackNotRunningError
  | StackReadinessError
> =>
  Effect.gen(function* () {
    const body = yield* dieOnBodyDecodeError(
      endpoint,
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
      case "STACK_NOT_RUNNING":
        return yield* new StackNotRunningError({ phase: body.phase ?? "unknown" });
    }
  });

const expectDaemonOk = (
  endpoint: ControlEndpoint,
  path: string,
  response: HttpClientResponse.HttpClientResponse,
  fallbackName: string,
): Effect.Effect<
  void,
  ServiceNotFoundError | ServiceReadyError | StackBuildError | StackReadinessError
> =>
  response.status >= 200 && response.status < 300
    ? Effect.void
    : failDaemonResponse(endpoint, path, response, fallbackName).pipe(
        Effect.catchTag("StackNotRunningError", (error) => Effect.die(error)),
      );

const expectMutatingDaemonOk = (
  endpoint: ControlEndpoint,
  path: string,
  response: HttpClientResponse.HttpClientResponse,
  fallbackName: string,
): Effect.Effect<
  void,
  | ServiceNotFoundError
  | ServiceReadyError
  | StackBuildError
  | StackNotRunningError
  | StackReadinessError
> =>
  response.status >= 200 && response.status < 300
    ? Effect.void
    : failDaemonResponse(endpoint, path, response, fallbackName);

/** Fetch JSON from the daemon, dying on HTTP errors. */
function fetchStatus(endpoint: ControlEndpoint, path: string, method = "GET") {
  return Effect.gen(function* () {
    const response = yield* httpResponse(endpoint, path, { method });
    const okResponse = yield* dieOnNonOkStatus(
      endpoint,
      path,
      HttpClientResponse.filterStatusOk(response),
    );
    return yield* dieOnBodyDecodeError(
      endpoint,
      path,
      HttpClientResponse.schemaBodyJson(StatusResponseSchema)(okResponse),
    );
  });
}

function fetchLogEntries(endpoint: ControlEndpoint, path: string) {
  return Effect.gen(function* () {
    const response = yield* httpResponse(endpoint, path);
    const okResponse = yield* dieOnNonOkStatus(
      endpoint,
      path,
      HttpClientResponse.filterStatusOk(response),
    );
    return yield* dieOnBodyDecodeError(
      endpoint,
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
function sseStream<A>(
  endpoint: ControlEndpoint,
  path: string,
  parse: (data: string) => Effect.Effect<A, HttpTransportClientError>,
) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const controller = new AbortController();
      const response = yield* httpFetch(endpoint, path, { signal: controller.signal });
      if (!response.ok) {
        return yield* new HttpTransportClientError({
          endpoint,
          path,
          cause: new Error(`SSE request failed: ${response.status}`),
          reason: "status",
        });
      }
      const body = response.body;
      if (body === null) {
        return yield* new HttpTransportClientError({
          endpoint,
          path,
          cause: new Error("SSE response body is missing"),
          reason: "protocol",
        });
      }

      // State shared across chunks — parser is stateful, accumulates partial events
      const collected: string[] = [];
      const parser = Sse.makeParser((event) => {
        if (Predicate.isTagged(event, "Event")) {
          collected.push(event.data);
        }
      });

      return Stream.fromReadableStream({
        evaluate: () => body,
        onError: (cause) =>
          new HttpTransportClientError({ endpoint, path, cause, reason: "transport" }),
      }).pipe(
        Stream.mapEffect((chunk: Uint8Array) =>
          Effect.sync(() => {
            collected.length = 0;
            parser.feed(new TextDecoder().decode(chunk, { stream: true }));
            return Array.from(collected);
          }).pipe(Effect.flatMap((events) => Effect.forEach(events, parse))),
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
 * RemoteStack implements the Stack interface over HTTP to a daemon running
 * on a deterministic loopback control endpoint.
 * This allows the CLI to transparently switch between foreground
 * (in-process) and detached (daemon) modes.
 */
export const RemoteStack = {
  layer: (endpoint: ControlEndpoint): Layer.Layer<Stack, never, HttpTransportClient> =>
    Layer.effect(
      Stack,
      Effect.gen(function* () {
        const httpTransportClient = yield* HttpTransportClient;
        const httpTransportClientLayer = Layer.succeed(HttpTransportClient, httpTransportClient);
        const withHttpTransportClient = <A, E, R>(
          effect: Effect.Effect<A, E | HttpTransportClientError, R | HttpTransportClient>,
        ) =>
          effect.pipe(
            Effect.provide(httpTransportClientLayer),
            Effect.catchTag("HttpTransportClientError", (error) => Effect.die(error)),
          );
        const withHttpTransportClientStream = <A, E, R>(
          stream: Stream.Stream<A, E | HttpTransportClientError, R | HttpTransportClient>,
        ) =>
          stream.pipe(
            Stream.provide(httpTransportClientLayer),
            Stream.catchTag("HttpTransportClientError", (error) => Stream.die(error)),
          );
        const withLifecycleRequest = <A, E, R>(
          request: (signal: AbortSignal) => Effect.Effect<A, E | HttpTransportClientError, R>,
        ) => withHttpTransportClient(withAbortSignal(request));

        return {
          getInfo: () =>
            withHttpTransportClient(
              Effect.map(fetchStatus(endpoint, "/status"), (res) => res.info),
            ),

          start: () =>
            withLifecycleRequest((signal) =>
              Effect.gen(function* () {
                const path = "/start";
                const response = yield* httpResponse(endpoint, path, { method: "POST", signal });
                yield* expectDaemonOk(endpoint, path, response, "stack").pipe(
                  Effect.catchTag("ServiceNotFoundError", (error) => Effect.die(error)),
                );
              }),
            ),

          stop: () =>
            withLifecycleRequest((signal) =>
              Effect.gen(function* () {
                const path = "/stop";
                const response = yield* httpResponse(endpoint, path, { method: "POST", signal });
                yield* dieOnNonOkStatus(
                  endpoint,
                  path,
                  HttpClientResponse.filterStatusOk(response),
                );
              }),
            ),

          dispose: () =>
            withLifecycleRequest((signal) =>
              Effect.gen(function* () {
                const path = "/stop";
                const response = yield* httpResponse(endpoint, path, { method: "POST", signal });
                yield* dieOnNonOkStatus(
                  endpoint,
                  path,
                  HttpClientResponse.filterStatusOk(response),
                );
              }),
            ),

          startService: (name: string) =>
            withLifecycleRequest((signal) =>
              Effect.gen(function* () {
                const servicePath = yield* publicServicePath(name);
                const path = `/services/${servicePath}/start`;
                const response = yield* httpResponse(endpoint, path, {
                  method: "POST",
                  signal,
                });
                yield* expectMutatingDaemonOk(endpoint, path, response, name);
              }),
            ),

          stopService: (name: string) =>
            withLifecycleRequest((signal) =>
              Effect.gen(function* () {
                const servicePath = yield* publicServicePath(name);
                const path = `/services/${servicePath}/stop`;
                const response = yield* httpResponse(endpoint, path, {
                  method: "POST",
                  signal,
                });
                yield* expectMutatingDaemonOk(endpoint, path, response, name).pipe(
                  Effect.catchTag("ServiceReadyError", (error) => Effect.die(error)),
                  Effect.catchTag("StackReadinessError", (error) => Effect.die(error)),
                );
              }),
            ),

          restartService: (name: string) =>
            withLifecycleRequest((signal) =>
              Effect.gen(function* () {
                const servicePath = yield* publicServicePath(name);
                const path = `/services/${servicePath}/restart`;
                const response = yield* httpResponse(endpoint, path, {
                  method: "POST",
                  signal,
                });
                yield* expectMutatingDaemonOk(endpoint, path, response, name);
              }),
            ),

          reloadFunctions: (opts) =>
            withLifecycleRequest((signal) =>
              Effect.gen(function* () {
                const path = "/functions/reload";
                const response = yield* httpResponse(endpoint, path, {
                  method: "POST",
                  signal,
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(opts ?? {}),
                });
                yield* expectMutatingDaemonOk(endpoint, path, response, "edge-runtime");
              }),
            ),

          reloadEdgeRuntime: (opts) =>
            withLifecycleRequest((signal) =>
              Effect.gen(function* () {
                const path = "/edge-runtime/reload";
                const response = yield* httpResponse(endpoint, path, {
                  method: "POST",
                  signal,
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(opts),
                });
                yield* expectMutatingDaemonOk(endpoint, path, response, "edge-runtime");
              }),
            ),

          getState: (name: string) =>
            withHttpTransportClient(
              Effect.gen(function* () {
                const { services } = yield* fetchStatus(endpoint, "/status");
                const match = services.find((s) => s.name === name);
                if (!match) {
                  return yield* new ServiceNotFoundError({ name });
                }
                return toServiceState(match);
              }),
            ),

          getAllStates: () =>
            withHttpTransportClient(
              Effect.map(fetchStatus(endpoint, "/status"), (res) =>
                res.services.map(toServiceState),
              ),
            ),

          stateChanges: (name: string) =>
            withHttpTransportClient(
              Effect.gen(function* () {
                // Verify the service exists first
                const { services } = yield* fetchStatus(endpoint, "/status");
                if (!services.some((s) => s.name === name)) {
                  return yield* new ServiceNotFoundError({ name });
                }
                return withHttpTransportClientStream(
                  sseStream(endpoint, "/status/stream", (data) =>
                    decodeStatusServiceEvent(endpoint, "/status/stream", data),
                  ).pipe(Stream.filter((s) => s.name === name)),
                );
              }),
            ),

          allStateChanges: () =>
            withHttpTransportClientStream(
              sseStream(endpoint, "/status/stream", (data) =>
                decodeStatusServiceEvent(endpoint, "/status/stream", data),
              ),
            ),

          waitReady: (name, opts) =>
            withHttpTransportClient(
              withAbortSignal((signal) =>
                Effect.gen(function* () {
                  const servicePath = yield* publicServicePath(name);
                  const path = `/services/${servicePath}/ready`;
                  const response = yield* httpResponse(endpoint, path, {
                    method: "POST",
                    signal,
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(opts ?? inheritReadyOptions),
                  });
                  yield* expectDaemonOk(endpoint, path, response, name);
                }),
              ),
            ),

          waitAllReady: (opts) =>
            withHttpTransportClient(
              withAbortSignal((signal) =>
                Effect.gen(function* () {
                  const path = "/ready";
                  const response = yield* httpResponse(endpoint, path, {
                    method: "POST",
                    signal,
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(opts ?? inheritReadyOptions),
                  });
                  yield* expectDaemonOk(endpoint, path, response, "stack").pipe(
                    Effect.catchTag("ServiceNotFoundError", (error) => Effect.die(error)),
                  );
                }),
              ),
            ),

          subscribeLogs: (name: string) =>
            withHttpTransportClientStream(
              sseStream<LogEntry>(endpoint, `/logs/${encodeURIComponent(name)}`, (data) =>
                decodeLogEntryEvent(endpoint, `/logs/${encodeURIComponent(name)}`, data),
              ),
            ),

          subscribeAllLogs: (services) => {
            const query = encodeSearchParams({ service: services });
            return withHttpTransportClientStream(
              sseStream<LogEntry>(endpoint, `/logs${query}`, (data) =>
                decodeLogEntryEvent(endpoint, `/logs${query}`, data),
              ),
            );
          },

          logHistory: (name: string, limit?: number) => {
            const query = limit !== undefined ? `?limit=${limit}` : "";
            return withHttpTransportClient(
              fetchLogEntries(endpoint, `/logs/${encodeURIComponent(name)}/history${query}`),
            );
          },

          logHistoryAll: (limit?: number, services?: ReadonlyArray<string>) => {
            const query = encodeSearchParams({ limit, service: services });
            return withHttpTransportClient(fetchLogEntries(endpoint, `/logs/history${query}`));
          },
        };
      }),
    ),
};
