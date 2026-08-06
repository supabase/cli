import { Deferred, Effect, Layer, Context, Stream } from "effect";
import {
  Headers,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Sse from "effect/unstable/encoding/Sse";
import type { DaemonErrorResponse } from "./DaemonProtocol.ts";
import { FunctionsReloadConfigSchema } from "./functions.ts";
import { EdgeRuntimeReloadConfigSchema, Stack } from "./Stack.ts";
import { ReadyOptionsSchema } from "./StackConfig.ts";

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DaemonServer extends Context.Service<
  DaemonServer,
  {
    readonly address: HttpServer.Address;
    readonly awaitShutdown: Effect.Effect<void>;
  }
>()("stack/DaemonServer") {
  static layerWithShutdown = (
    beforeShutdown: Effect.Effect<void> = Effect.void,
  ): Layer.Layer<DaemonServer, never, Stack | HttpServer.HttpServer> =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const stack = yield* Stack;
        const server = yield* HttpServer.HttpServer;
        const shutdownDeferred = yield* Deferred.make<void>();
        const textEncoder = new TextEncoder();
        const errorResponse = (body: DaemonErrorResponse, status: 400 | 404 | 500) =>
          HttpServerResponse.jsonUnsafe(body, { status });
        const notFoundResponse = (name: string) =>
          errorResponse(
            { code: "SERVICE_NOT_FOUND", error: `Service not found: ${name}`, service: name },
            404,
          );
        const notReadyResponse = (name: string, reason: string, exitCode?: number) =>
          errorResponse(
            {
              code: "SERVICE_NOT_READY",
              error: reason,
              service: name,
              ...(exitCode === undefined ? {} : { exitCode }),
            },
            500,
          );
        const buildErrorResponse = (detail: string) =>
          errorResponse({ code: "STACK_BUILD_ERROR", error: detail }, 500);
        const invalidReloadPayloadResponse = () =>
          errorResponse(
            { code: "STACK_BUILD_ERROR", error: "Invalid Edge Functions reload payload" },
            400,
          );
        const readinessTimeoutResponse = (target: string, timeoutMs: number, detail: string) =>
          errorResponse(
            {
              code: "STACK_READINESS_TIMEOUT",
              error: detail,
              service: target,
              timeoutMs,
            },
            500,
          );
        const beginShutdown = beforeShutdown.pipe(
          Effect.ensuring(
            // The HTTP module has no response-flushed hook. Delay the process
            // shutdown signal long enough for the final JSON response to leave
            // the socket.
            Deferred.succeed(shutdownDeferred, void 0).pipe(
              Effect.delay("25 millis"),
              Effect.forkDetach,
            ),
          ),
        );
        const terminalReadinessResponse = (target: string, timeoutMs: number, detail: string) =>
          beginShutdown.pipe(Effect.as(readinessTimeoutResponse(target, timeoutMs, detail)));

        // Helper: wrap an Effect Stream as a text/event-stream response
        const sseResponse = <A>(
          stream: Stream.Stream<A>,
          event: string,
          toData: (a: A) => string,
        ): HttpServerResponse.HttpServerResponse =>
          HttpServerResponse.stream(
            stream.pipe(
              Stream.map((a) =>
                textEncoder.encode(
                  Sse.encoder.write({ _tag: "Event", event, id: undefined, data: toData(a) }),
                ),
              ),
            ),
            {
              status: 200,
              contentType: "text/event-stream",
              headers: Headers.fromInput({
                "cache-control": "no-cache",
                connection: "keep-alive",
              }),
            },
          );

        const routes = [
          // Health check
          HttpRouter.route("GET", "/health", HttpServerResponse.text("OK", { status: 200 })),

          // Status: connection info + all service states
          HttpRouter.route(
            "GET",
            "/status",
            Effect.gen(function* () {
              const info = yield* stack.getInfo();
              const services = yield* stack.getAllStates();
              return HttpServerResponse.jsonUnsafe({ info, services });
            }),
          ),

          // Status stream: SSE of service state changes
          HttpRouter.route(
            "GET",
            "/status/stream",
            Effect.sync(() =>
              sseResponse(stack.allStateChanges(), "state", (s) => JSON.stringify(s)),
            ),
          ),

          // Start: begin service startup
          HttpRouter.route(
            "POST",
            "/start",
            Effect.gen(function* () {
              yield* stack.start();
              return HttpServerResponse.jsonUnsafe({ ok: true });
            }).pipe(
              Effect.catchTag("ServiceReadyError", (e) =>
                Effect.succeed(notReadyResponse(e.name, e.reason, e.exitCode)),
              ),
              Effect.catchTag("StackBuildError", (e) =>
                Effect.succeed(buildErrorResponse(e.detail)),
              ),
              Effect.catchTag("StackReadinessError", (e) =>
                terminalReadinessResponse(e.target, e.timeoutMs, e.detail),
              ),
            ),
          ),

          HttpRouter.route(
            "POST",
            "/ready",
            Effect.gen(function* () {
              const opts = yield* HttpServerRequest.schemaBodyJson(ReadyOptionsSchema);
              yield* stack.waitAllReady(opts);
              return HttpServerResponse.jsonUnsafe({ ok: true });
            }).pipe(
              Effect.catchTag("ServiceReadyError", (e) =>
                Effect.succeed(notReadyResponse(e.name, e.reason, e.exitCode)),
              ),
              Effect.catchTag("StackBuildError", (e) =>
                Effect.succeed(buildErrorResponse(e.detail)),
              ),
              Effect.catchTag("StackReadinessError", (e) =>
                terminalReadinessResponse(e.target, e.timeoutMs, e.detail),
              ),
            ),
          ),

          // Stop: graceful shutdown
          HttpRouter.route(
            "POST",
            "/stop",
            Effect.gen(function* () {
              yield* stack.stop();
              yield* beginShutdown;
              return HttpServerResponse.jsonUnsafe({ ok: true });
            }),
          ),

          // Logs: SSE of all logs
          HttpRouter.route(
            "GET",
            "/logs",
            Effect.gen(function* () {
              const searchParams = yield* HttpServerRequest.ParsedSearchParams;
              const services = parseServices(searchParams.service);
              return sseResponse(stack.subscribeAllLogs(services), "log", (e) => JSON.stringify(e));
            }),
          ),

          // Merged log history across all services
          HttpRouter.route(
            "GET",
            "/logs/history",
            Effect.gen(function* () {
              const searchParams = yield* HttpServerRequest.ParsedSearchParams;
              const limit = parseLimit(searchParams.limit);
              const services = parseServices(searchParams.service);
              const entries = yield* stack.logHistoryAll(limit, services);
              return HttpServerResponse.jsonUnsafe(entries);
            }),
          ),

          // Log history for a service (registered before /logs/:service to avoid shadowing)
          HttpRouter.route(
            "GET",
            "/logs/:service/history",
            Effect.gen(function* () {
              const routeParams = yield* HttpRouter.params;
              const searchParams = yield* HttpServerRequest.ParsedSearchParams;
              const service = parseSingleParam(routeParams.service)!;
              const limit = parseLimit(searchParams.limit);
              const entries = yield* stack.logHistory(service, limit);
              return HttpServerResponse.jsonUnsafe(entries);
            }),
          ),

          // Logs for a specific service: SSE
          HttpRouter.route(
            "GET",
            "/logs/:service",
            Effect.gen(function* () {
              const routeParams = yield* HttpRouter.params;
              const service = parseSingleParam(routeParams.service)!;
              return sseResponse(stack.subscribeLogs(service), "log", (e) => JSON.stringify(e));
            }),
          ),

          // Per-service control
          HttpRouter.route(
            "POST",
            "/services/:name/start",
            Effect.gen(function* () {
              const routeParams = yield* HttpRouter.params;
              yield* stack.startService(routeParams.name!);
              return HttpServerResponse.jsonUnsafe({ ok: true });
            }).pipe(
              Effect.catchTag("ServiceNotFoundError", (e) =>
                Effect.succeed(notFoundResponse(e.name)),
              ),
              Effect.catchTag("ServiceReadyError", (e) =>
                Effect.succeed(notReadyResponse(e.name, e.reason, e.exitCode)),
              ),
              Effect.catchTag("StackBuildError", (e) =>
                Effect.succeed(buildErrorResponse(e.detail)),
              ),
              Effect.catchTag("StackReadinessError", (e) =>
                terminalReadinessResponse(e.target, e.timeoutMs, e.detail),
              ),
            ),
          ),

          HttpRouter.route(
            "POST",
            "/services/:name/ready",
            Effect.gen(function* () {
              const routeParams = yield* HttpRouter.params;
              const opts = yield* HttpServerRequest.schemaBodyJson(ReadyOptionsSchema);
              yield* stack.waitReady(routeParams.name!, opts);
              return HttpServerResponse.jsonUnsafe({ ok: true });
            }).pipe(
              Effect.catchTag("ServiceNotFoundError", (e) =>
                Effect.succeed(notFoundResponse(e.name)),
              ),
              Effect.catchTag("ServiceReadyError", (e) =>
                Effect.succeed(notReadyResponse(e.name, e.reason, e.exitCode)),
              ),
              Effect.catchTag("StackBuildError", (e) =>
                Effect.succeed(buildErrorResponse(e.detail)),
              ),
              Effect.catchTag("StackReadinessError", (e) =>
                terminalReadinessResponse(e.target, e.timeoutMs, e.detail),
              ),
            ),
          ),

          HttpRouter.route(
            "POST",
            "/services/:name/stop",
            Effect.gen(function* () {
              const routeParams = yield* HttpRouter.params;
              yield* stack.stopService(routeParams.name!);
              return HttpServerResponse.jsonUnsafe({ ok: true });
            }).pipe(
              Effect.catchTag("ServiceNotFoundError", (e) =>
                Effect.succeed(notFoundResponse(e.name)),
              ),
              Effect.catchTag("StackBuildError", (e) =>
                Effect.succeed(buildErrorResponse(e.detail)),
              ),
            ),
          ),

          HttpRouter.route(
            "POST",
            "/services/:name/restart",
            Effect.gen(function* () {
              const routeParams = yield* HttpRouter.params;
              yield* stack.restartService(routeParams.name!);
              return HttpServerResponse.jsonUnsafe({ ok: true });
            }).pipe(
              Effect.catchTag("ServiceNotFoundError", (e) =>
                Effect.succeed(notFoundResponse(e.name)),
              ),
              Effect.catchTag("ServiceReadyError", (e) =>
                Effect.succeed(notReadyResponse(e.name, e.reason, e.exitCode)),
              ),
              Effect.catchTag("StackBuildError", (e) =>
                Effect.succeed(buildErrorResponse(e.detail)),
              ),
              Effect.catchTag("StackReadinessError", (e) =>
                terminalReadinessResponse(e.target, e.timeoutMs, e.detail),
              ),
            ),
          ),

          HttpRouter.route(
            "POST",
            "/functions/reload",
            Effect.gen(function* () {
              const body = yield* HttpServerRequest.schemaBodyJson(FunctionsReloadConfigSchema);
              yield* stack.reloadFunctions(body);
              return HttpServerResponse.jsonUnsafe({ ok: true });
            }).pipe(
              Effect.catchTags({
                SchemaError: () => Effect.succeed(invalidReloadPayloadResponse()),
                HttpServerError: () => Effect.succeed(invalidReloadPayloadResponse()),
              }),
              Effect.catchTag("ServiceNotFoundError", (e) =>
                Effect.succeed(notFoundResponse(e.name)),
              ),
              Effect.catchTag("ServiceReadyError", (e) =>
                Effect.succeed(notReadyResponse(e.name, e.reason, e.exitCode)),
              ),
              Effect.catchTag("StackBuildError", (e) =>
                Effect.succeed(buildErrorResponse(e.detail)),
              ),
              Effect.catchTag("StackReadinessError", (e) =>
                terminalReadinessResponse(e.target, e.timeoutMs, e.detail),
              ),
            ),
          ),

          HttpRouter.route(
            "POST",
            "/edge-runtime/reload",
            Effect.gen(function* () {
              const body = yield* HttpServerRequest.schemaBodyJson(EdgeRuntimeReloadConfigSchema);
              yield* stack.reloadEdgeRuntime(body);
              return HttpServerResponse.jsonUnsafe({ ok: true });
            }).pipe(
              Effect.catchTags({
                SchemaError: () => Effect.succeed(invalidReloadPayloadResponse()),
                HttpServerError: () => Effect.succeed(invalidReloadPayloadResponse()),
              }),
              Effect.catchTag("ServiceNotFoundError", (e) =>
                Effect.succeed(notFoundResponse(e.name)),
              ),
              Effect.catchTag("ServiceReadyError", (e) =>
                Effect.succeed(notReadyResponse(e.name, e.reason, e.exitCode)),
              ),
              Effect.catchTag("StackBuildError", (e) =>
                Effect.succeed(buildErrorResponse(e.detail)),
              ),
              Effect.catchTag("StackReadinessError", (e) =>
                terminalReadinessResponse(e.target, e.timeoutMs, e.detail),
              ),
            ),
          ),
        ];

        const httpEffect = yield* HttpRouter.toHttpEffect(HttpRouter.addAll(routes));
        yield* Effect.forkScoped(server.serve(httpEffect));

        return {
          address: server.address,
          awaitShutdown: Deferred.await(shutdownDeferred),
        };
      }),
    );

  static layer: Layer.Layer<DaemonServer, never, Stack | HttpServer.HttpServer> =
    this.layerWithShutdown();
}

function parseLimit(value: string | ReadonlyArray<string> | undefined): number | undefined {
  const raw = Array.isArray(value) ? value.at(0) : value;
  if (raw === undefined) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseServices(
  value: string | ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? [value] : value;
}

function parseSingleParam(value: string | ReadonlyArray<string> | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : value[0];
}
