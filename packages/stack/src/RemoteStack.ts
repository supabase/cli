import { ServiceNotFoundError, ServiceReadyError, type LogEntry } from "@supabase/process-compose";
import { Effect, Layer, Schema, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { Stack, StackInfoSchema } from "./Stack.ts";
import { StackServiceState, StackServiceStatusSchema } from "./StackServiceState.ts";
import { UnixHttpClient, UnixHttpClientError } from "./UnixHttpClient.ts";

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

const ServiceErrorResponseSchema = Schema.Struct({
  error: Schema.String,
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
  return Effect.flatMap(UnixHttpClient.asEffect(), (client) =>
    client.request(socketPath, path, init),
  );
}

function unixResponse(socketPath: string, path: string, init?: RequestInit) {
  const request = makeRequest(path, init);
  return Effect.map(unixFetch(socketPath, path, init), (response) =>
    HttpClientResponse.fromWeb(request, response),
  );
}

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
                yield* HttpClientResponse.filterStatusOk(response).pipe(Effect.orDie);
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
                const response = yield* unixResponse(socketPath, `/services/${name}/start`, {
                  method: "POST",
                });
                if (response.status === 404) {
                  return yield* new ServiceNotFoundError({ name });
                }
                if (response.status === 500) {
                  const body = yield* HttpClientResponse.schemaBodyJson(ServiceErrorResponseSchema)(
                    response,
                  ).pipe(Effect.orDie);
                  return yield* new ServiceReadyError({ name, reason: body.error });
                }
                yield* HttpClientResponse.filterStatusOk(response).pipe(Effect.orDie);
              }),
            ),

          stopService: (name: string) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const response = yield* unixResponse(socketPath, `/services/${name}/stop`, {
                  method: "POST",
                });
                if (response.status === 404) {
                  return yield* new ServiceNotFoundError({ name });
                }
                yield* HttpClientResponse.filterStatusOk(response).pipe(Effect.orDie);
              }),
            ),

          restartService: (name: string) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const response = yield* unixResponse(socketPath, `/services/${name}/restart`, {
                  method: "POST",
                });
                if (response.status === 404) {
                  return yield* new ServiceNotFoundError({ name });
                }
                yield* HttpClientResponse.filterStatusOk(response).pipe(Effect.orDie);
              }),
            ),

          reloadFunctions: (opts) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                const response = yield* unixResponse(
                  socketPath,
                  `/functions/reload${encodeSearchParams({
                    envFile: opts?.envFile,
                    noVerifyJwt:
                      opts?.noVerifyJwt === undefined ? undefined : String(opts.noVerifyJwt),
                  })}`,
                  { method: "POST" },
                );
                if (response.status === 404) {
                  return yield* new ServiceNotFoundError({ name: "edge-runtime" });
                }
                if (response.status === 500) {
                  const body = yield* HttpClientResponse.schemaBodyJson(ServiceErrorResponseSchema)(
                    response,
                  ).pipe(Effect.orDie);
                  return yield* new ServiceReadyError({
                    name: "edge-runtime",
                    reason: body.error,
                  });
                }
                yield* HttpClientResponse.filterStatusOk(response).pipe(Effect.orDie);
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

          waitReady: (name: string) =>
            withUnixHttpClient(
              Effect.gen(function* () {
                // Check current state first
                const { services } = yield* fetchStatus(socketPath, "/status");
                const match = services.find((s) => s.name === name);
                if (!match) {
                  return yield* new ServiceNotFoundError({ name });
                }
                if (match.status === "Healthy" || match.status === "Running") return;

                // Wait for state change via SSE
                yield* withUnixHttpClient(
                  sseStream(socketPath, "/status/stream", (data) => {
                    const raw = decodeStatusServiceEvent(data);
                    return toServiceState(raw);
                  }).pipe(
                    Stream.filter((s) => s.name === name),
                    Stream.takeUntil((s) => s.status === "Healthy" || s.status === "Running"),
                    Stream.runDrain,
                  ),
                );
              }),
            ),

          waitAllReady: () =>
            withUnixHttpClient(
              Effect.gen(function* () {
                // Check current state first
                const { services } = yield* fetchStatus(socketPath, "/status");
                const allReady = services.every(
                  (s) => s.status === "Healthy" || s.status === "Running",
                );
                if (allReady) return;

                // Track service readiness via SSE
                const readySet = new Set(
                  services
                    .filter((s) => s.status === "Healthy" || s.status === "Running")
                    .map((s) => s.name),
                );
                const totalCount = services.length;

                yield* withUnixHttpClient(
                  sseStream(socketPath, "/status/stream", (data) => {
                    const raw = decodeStatusServiceEvent(data);
                    return toServiceState(raw);
                  }).pipe(
                    Stream.takeUntil((s) => {
                      if (s.status === "Healthy" || s.status === "Running") {
                        readySet.add(s.name);
                      }
                      return readySet.size >= totalCount;
                    }),
                    Stream.runDrain,
                  ),
                );
              }),
            ),

          subscribeLogs: (name: string) =>
            withUnixHttpClientStream(
              sseStream<LogEntry>(socketPath, `/logs/${name}`, (data) => decodeLogEntryEvent(data)),
            ),

          subscribeAllLogs: (services) => {
            const query = encodeSearchParams({ service: services });
            return withUnixHttpClientStream(
              sseStream<LogEntry>(socketPath, `/logs${query}`, (data) => decodeLogEntryEvent(data)),
            );
          },

          logHistory: (name: string, limit?: number) => {
            const query = limit !== undefined ? `?limit=${limit}` : "";
            return withUnixHttpClient(fetchLogEntries(socketPath, `/logs/${name}/history${query}`));
          },

          logHistoryAll: (limit?: number, services?: ReadonlyArray<string>) => {
            const query = encodeSearchParams({ limit, service: services });
            return withUnixHttpClient(fetchLogEntries(socketPath, `/logs/history${query}`));
          },
        };
      }),
    ),
};
