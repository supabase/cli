import { Deferred, Effect, Layer, ServiceMap, Stream } from "effect";
import {
  Headers,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Sse from "effect/unstable/encoding/Sse";
import { Stack } from "./Stack.ts";

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DaemonServer extends ServiceMap.Service<
  DaemonServer,
  {
    readonly address: HttpServer.Address;
    readonly awaitShutdown: Effect.Effect<void>;
  }
>()("stack/DaemonServer") {
  static layer: Layer.Layer<DaemonServer, never, Stack | HttpServer.HttpServer> = Layer.effect(
    this,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const server = yield* HttpServer.HttpServer;
      const shutdownDeferred = yield* Deferred.make<void>();

      // Helper: wrap an Effect Stream as a text/event-stream response
      const sseResponse = <A>(
        stream: Stream.Stream<A>,
        event: string,
        toData: (a: A) => string,
      ): HttpServerResponse.HttpServerResponse =>
        HttpServerResponse.stream(
          stream.pipe(
            Stream.map((a) =>
              new TextEncoder().encode(
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
          }),
        ),

        // Stop: graceful shutdown
        HttpRouter.route(
          "POST",
          "/stop",
          Effect.gen(function* () {
            yield* stack.stop();
            yield* Deferred.succeed(shutdownDeferred, void 0);
            return HttpServerResponse.jsonUnsafe({ ok: true });
          }),
        ),

        // Logs: SSE of all logs
        HttpRouter.route(
          "GET",
          "/logs",
          Effect.sync(() => sseResponse(stack.subscribeAllLogs(), "log", (e) => JSON.stringify(e))),
        ),

        // Log history for a service (registered before /logs/:service to avoid shadowing)
        HttpRouter.route(
          "GET",
          "/logs/:service/history",
          Effect.gen(function* () {
            const routeParams = yield* HttpRouter.params;
            const searchParams = yield* HttpServerRequest.ParsedSearchParams.asEffect();
            const service = routeParams.service!;
            const limitStr = searchParams.limit;
            const limit = typeof limitStr === "string" ? parseInt(limitStr, 10) : undefined;
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
            const service = routeParams.service!;
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
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  { error: `Service not found: ${e.name}` },
                  { status: 404 },
                ),
              ),
            ),
            Effect.catchTag("ServiceReadyError", (e) =>
              Effect.succeed(HttpServerResponse.jsonUnsafe({ error: e.reason }, { status: 500 })),
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
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  { error: `Service not found: ${e.name}` },
                  { status: 404 },
                ),
              ),
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
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  { error: `Service not found: ${e.name}` },
                  { status: 404 },
                ),
              ),
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
}
