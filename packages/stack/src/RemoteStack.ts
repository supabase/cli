import {
  ServiceNotFoundError,
  ServiceReadyError,
  ServiceState,
  type LogEntry,
} from "@supabase/process-compose";
import { Effect, Layer, Stream } from "effect";
import * as Sse from "effect/unstable/encoding/Sse";
import { Stack, type StackInfo } from "./Stack.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StatusResponse {
  readonly info: StackInfo;
  readonly services: ReadonlyArray<{
    readonly name: string;
    readonly status: string;
    readonly pid: number | null;
    readonly exitCode: number | null;
    readonly restartCount: number;
    readonly startedAt: number | null;
    readonly error: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a fetch request to the daemon Unix socket. */
function unixFetch(socketPath: string, path: string, init?: RequestInit): Effect.Effect<Response> {
  return Effect.promise(() =>
    fetch(`http://localhost${path}`, { ...init, unix: socketPath } as RequestInit),
  );
}

/** Fetch JSON from the daemon, dying on HTTP errors. */
function fetchJson<A>(socketPath: string, path: string, method = "GET"): Effect.Effect<A> {
  return Effect.gen(function* () {
    const response = yield* unixFetch(socketPath, path, { method });
    if (!response.ok) {
      return yield* Effect.die(new Error(`HTTP ${response.status}: ${path}`));
    }
    return (yield* Effect.promise(() => response.json())) as A;
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
  socketPath: string,
  path: string,
  parse: (data: string) => A,
): Stream.Stream<A> {
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
        onError: (error) => error as Error,
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
function toServiceState(raw: StatusResponse["services"][number]): ServiceState {
  return new ServiceState({
    name: raw.name,
    status: raw.status as ServiceState["status"],
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
  layer: (socketPath: string): Layer.Layer<Stack> =>
    Layer.succeed(Stack, {
      getInfo: () =>
        Effect.map(fetchJson<StatusResponse>(socketPath, "/status"), (res) => res.info),

      start: () =>
        Effect.gen(function* () {
          const response = yield* unixFetch(socketPath, "/start", { method: "POST" });
          if (!response.ok) {
            return yield* Effect.die(new Error(`POST /start failed: ${response.status}`));
          }
        }),

      stop: () =>
        Effect.gen(function* () {
          const response = yield* unixFetch(socketPath, "/stop", { method: "POST" });
          if (!response.ok) {
            return yield* Effect.die(new Error(`POST /stop failed: ${response.status}`));
          }
        }),

      dispose: () =>
        Effect.gen(function* () {
          const response = yield* unixFetch(socketPath, "/stop", { method: "POST" });
          if (!response.ok) {
            return yield* Effect.die(new Error(`POST /stop failed: ${response.status}`));
          }
        }),

      startService: (name: string) =>
        Effect.gen(function* () {
          const response = yield* unixFetch(socketPath, `/services/${name}/start`, {
            method: "POST",
          });
          if (response.status === 404) {
            return yield* new ServiceNotFoundError({ name });
          }
          if (response.status === 500) {
            const body = (yield* Effect.promise(() => response.json())) as { error: string };
            return yield* new ServiceReadyError({ name, reason: body.error });
          }
          if (!response.ok) {
            return yield* Effect.die(new Error(`HTTP ${response.status}`));
          }
        }),

      stopService: (name: string) =>
        Effect.gen(function* () {
          const response = yield* unixFetch(socketPath, `/services/${name}/stop`, {
            method: "POST",
          });
          if (response.status === 404) {
            return yield* new ServiceNotFoundError({ name });
          }
          if (!response.ok) {
            return yield* Effect.die(new Error(`HTTP ${response.status}`));
          }
        }),

      restartService: (name: string) =>
        Effect.gen(function* () {
          const response = yield* unixFetch(socketPath, `/services/${name}/restart`, {
            method: "POST",
          });
          if (response.status === 404) {
            return yield* new ServiceNotFoundError({ name });
          }
          if (!response.ok) {
            return yield* Effect.die(new Error(`HTTP ${response.status}`));
          }
        }),

      getState: (name: string) =>
        Effect.gen(function* () {
          const { services } = yield* fetchJson<StatusResponse>(socketPath, "/status");
          const match = services.find((s) => s.name === name);
          if (!match) {
            return yield* new ServiceNotFoundError({ name });
          }
          return toServiceState(match);
        }),

      getAllStates: () =>
        Effect.map(fetchJson<StatusResponse>(socketPath, "/status"), (res) =>
          res.services.map(toServiceState),
        ),

      stateChanges: (name: string) =>
        Effect.gen(function* () {
          // Verify the service exists first
          const { services } = yield* fetchJson<StatusResponse>(socketPath, "/status");
          if (!services.some((s) => s.name === name)) {
            return yield* new ServiceNotFoundError({ name });
          }
          return sseStream(socketPath, "/status/stream", (data) => {
            const raw = JSON.parse(data) as StatusResponse["services"][number];
            return toServiceState(raw);
          }).pipe(Stream.filter((s) => s.name === name));
        }),

      allStateChanges: () =>
        sseStream(socketPath, "/status/stream", (data) => {
          const raw = JSON.parse(data) as StatusResponse["services"][number];
          return toServiceState(raw);
        }),

      waitReady: (name: string) =>
        Effect.gen(function* () {
          // Check current state first
          const { services } = yield* fetchJson<StatusResponse>(socketPath, "/status");
          const match = services.find((s) => s.name === name);
          if (!match) {
            return yield* new ServiceNotFoundError({ name });
          }
          if (match.status === "Healthy" || match.status === "Running") return;

          // Wait for state change via SSE
          yield* sseStream(socketPath, "/status/stream", (data) => {
            const raw = JSON.parse(data) as StatusResponse["services"][number];
            return toServiceState(raw);
          }).pipe(
            Stream.filter((s) => s.name === name),
            Stream.takeUntil((s) => s.status === "Healthy" || s.status === "Running"),
            Stream.runDrain,
          );
        }),

      waitAllReady: () =>
        Effect.gen(function* () {
          // Check current state first
          const { services } = yield* fetchJson<StatusResponse>(socketPath, "/status");
          const allReady = services.every((s) => s.status === "Healthy" || s.status === "Running");
          if (allReady) return;

          // Track service readiness via SSE
          const readySet = new Set(
            services
              .filter((s) => s.status === "Healthy" || s.status === "Running")
              .map((s) => s.name),
          );
          const totalCount = services.length;

          yield* sseStream(socketPath, "/status/stream", (data) => {
            const raw = JSON.parse(data) as StatusResponse["services"][number];
            return toServiceState(raw);
          }).pipe(
            Stream.takeUntil((s) => {
              if (s.status === "Healthy" || s.status === "Running") {
                readySet.add(s.name);
              }
              return readySet.size >= totalCount;
            }),
            Stream.runDrain,
          );
        }),

      subscribeLogs: (name: string) =>
        sseStream<LogEntry>(socketPath, `/logs/${name}`, (data) => JSON.parse(data) as LogEntry),

      subscribeAllLogs: (services) => {
        const query = encodeSearchParams({ service: services });
        return sseStream<LogEntry>(
          socketPath,
          `/logs${query}`,
          (data) => JSON.parse(data) as LogEntry,
        );
      },

      logHistory: (name: string, limit?: number) => {
        const query = limit !== undefined ? `?limit=${limit}` : "";
        return fetchJson<ReadonlyArray<LogEntry>>(socketPath, `/logs/${name}/history${query}`);
      },

      logHistoryAll: (limit?: number, services?: ReadonlyArray<string>) => {
        const query = encodeSearchParams({ limit, service: services });
        return fetchJson<ReadonlyArray<LogEntry>>(socketPath, `/logs/history${query}`);
      },
    }),
};
