import { ServiceNotFoundError, ServiceReadyError, type LogEntry } from "@supabase/process-compose";
import { Effect, Layer, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
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
  response: HttpClientResponse.HttpClientResponse,
  fallbackName: string,
): Effect.Effect<
  never,
  ServiceNotFoundError | ServiceReadyError | StackBuildError | StackReadinessError
> =>
  Effect.gen(function* () {
    const body = yield* HttpClientResponse.schemaBodyJson(DaemonErrorResponseSchema)(response).pipe(
      Effect.orDie,
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
        return yield* new StackBuildError({ detail: body.error });
      case "STACK_READINESS_TIMEOUT":
        return yield* new StackReadinessError({
          target: body.service ?? fallbackName,
          timeoutMs: body.timeoutMs ?? 0,
          detail: body.error,
        });
    }
  });

const expectDaemonOk = (
  response: HttpClientResponse.HttpClientResponse,
  fallbackName: string,
): Effect.Effect<
  void,
  ServiceNotFoundError | ServiceReadyError | StackBuildError | StackReadinessError
> =>
  response.status >= 200 && response.status < 300
    ? Effect.void
    : failDaemonResponse(response, fallbackName);

/** Fetch JSON from the daemon, dying on HTTP errors. */
function fetchStatus(socketPath: string, path: string, method = "GET") {
  return Effect.gen(function* () {
    const response = yield* unixResponse(socketPath, path, { method });
    const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(Effect.orDie);
    return yield* HttpClientResponse.schemaBodyJson(StatusResponseSchema)(okResponse).pipe(
      Effect.orDie,
    );
  });
}

function fetchLogEntries(socketPath: string, path: string) {
  return Effect.gen(function* () {
    const response = yield* unixResponse(socketPath, path);
    const okResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(Effect.orDie);
    return yield* HttpClientResponse.schemaBodyJson(Schema.Array(LogEntrySchema))(okResponse).pipe(
      Effect.orDie,
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
      if (!response.ok || !response.body) {
        return yield* Effect.die(new Error(`SSE request failed: ${response.status}`));
      }

      // State shared across chunks — parser is stateful, accumulates partial events
      const collected: A[] = [];
      const parser = Sse.makeParser((event) => {
        if (event._tag === "Event") {
          collected.push(parse(event.data));
        }
      });

      return Stream.fromReadableStream({
        evaluate: () => response.body!,
        onError: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        Stream.flatMap((chunk: Uint8Array) => {
          collected.length = 0;
          parser.feed(new TextDecoder().decode(chunk, { stream: true }));
          return Stream.fromIterable(Array.from(collected));
        }),
        Stream.orDie,
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
                const response = yield* unixResponse(socketPath, "/start", { method: "POST" });
                yield* expectDaemonOk(response, "stack").pipe(
                  Effect.catchTag("ServiceNotFoundError", (error) => Effect.die(error)),
                );
              }),
            ),

          stop: () =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const response = yield* unixResponse(socketPath, "/stop", { method: "POST" });
                yield* HttpClientResponse.filterStatusOk(response).pipe(Effect.orDie);
              }),
            ),

          dispose: () =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const response = yield* unixResponse(socketPath, "/stop", { method: "POST" });
                yield* HttpClientResponse.filterStatusOk(response).pipe(Effect.orDie);
              }),
            ),

          startService: (name: string) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const servicePath = yield* publicServicePath(name);
                const response = yield* unixResponse(socketPath, `/services/${servicePath}/start`, {
                  method: "POST",
                });
                yield* expectDaemonOk(response, name);
              }),
            ),

          stopService: (name: string) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const servicePath = yield* publicServicePath(name);
                const response = yield* unixResponse(socketPath, `/services/${servicePath}/stop`, {
                  method: "POST",
                });
                yield* expectDaemonOk(response, name).pipe(
                  Effect.catchTag("ServiceReadyError", (error) => Effect.die(error)),
                  Effect.catchTag("StackReadinessError", (error) => Effect.die(error)),
                );
              }),
            ),

          restartService: (name: string) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const servicePath = yield* publicServicePath(name);
                const response = yield* unixResponse(
                  socketPath,
                  `/services/${servicePath}/restart`,
                  {
                    method: "POST",
                  },
                );
                yield* expectDaemonOk(response, name);
              }),
            ),

          configureFunctions: (opts) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const response = yield* unixResponse(socketPath, "/functions/configure", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(opts),
                });
                yield* expectDaemonOk(response, "edge-runtime").pipe(
                  Effect.catchTag("ServiceReadyError", (error) => Effect.die(error)),
                  Effect.catchTag("StackReadinessError", (error) => Effect.die(error)),
                );
              }),
            ),

          reloadFunctions: (opts) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const response = yield* unixResponse(socketPath, "/functions/reload", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(opts ?? {}),
                });
                yield* expectDaemonOk(response, "edge-runtime");
              }),
            ),

          reloadEdgeRuntime: (opts) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const response = yield* unixResponse(socketPath, "/edge-runtime/reload", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(opts),
                });
                yield* expectDaemonOk(response, "edge-runtime");
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
                  const response = yield* unixResponse(
                    socketPath,
                    `/services/${servicePath}/ready`,
                    {
                      method: "POST",
                      signal,
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify(opts ?? inheritReadyOptions),
                    },
                  );
                  yield* expectDaemonOk(response, name);
                }),
              ),
            ),

          waitAllReady: (opts) =>
            withUnixHttpClient(
              withAbortSignal((signal) =>
                Effect.gen(function* () {
                  const response = yield* unixResponse(socketPath, "/ready", {
                    method: "POST",
                    signal,
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(opts ?? inheritReadyOptions),
                  });
                  yield* expectDaemonOk(response, "stack").pipe(
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
