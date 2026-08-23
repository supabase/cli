import { Effect, Layer } from "effect";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import { ControlStopRequestSchema } from "./DaemonProtocol.ts";
import { RuntimeGate } from "./RuntimeGate.ts";
import { StackRpc } from "./StackRpc.ts";
import {
  StackLaunchUpdater,
  StackRpcHandlers,
  type StackLaunchUpdater as StackLaunchUpdaterService,
} from "./StackRpcHandlers.ts";
import type { SupervisorLifecycle } from "./SupervisorLifecycle.ts";

/** Builds the complete static supervisor application before listener binding. */
export const makeSupervisorControlApplication = (
  lifecycle: SupervisorLifecycle["Service"],
  launchUpdater?: StackLaunchUpdaterService,
): Effect.Effect<
  Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest | import("effect/Scope").Scope
  >,
  never,
  import("effect/Scope").Scope
> =>
  Effect.gen(function* () {
    const handlers =
      launchUpdater === undefined
        ? StackRpcHandlers
        : StackRpcHandlers.pipe(Layer.provide(Layer.succeed(StackLaunchUpdater, launchUpdater)));
    const rpc = yield* RpcServer.toHttpEffect(StackRpc).pipe(
      Effect.provide(
        handlers.pipe(Layer.provide(Layer.succeed(RuntimeGate, RuntimeGate.make(lifecycle)))),
      ),
      Effect.provide(RpcSerialization.layerNdjson),
    );
    const routes = [
      HttpRouter.route(
        "GET",
        "/owner",
        lifecycle.currentStatus.pipe(Effect.map(HttpServerResponse.jsonUnsafe)),
      ),
      HttpRouter.route(
        "POST",
        "/stop",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.schemaBodyJson(ControlStopRequestSchema);
          const status = yield* lifecycle.currentStatus;
          if (
            request.ownershipId !== status.ownershipId ||
            request.ownerSessionId !== status.ownerSessionId
          ) {
            return HttpServerResponse.jsonUnsafe({ error: "conflict" }, { status: 409 });
          }
          // Submit ownership of the stop transaction before returning 202. The
          // post-response middleware releases the graceful-close gate only
          // after the platform has flushed this response.
          yield* lifecycle.submitShutdown("stop");
          return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 202 });
        }).pipe(
          Effect.catchTags({
            SchemaError: () =>
              Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid" }, { status: 400 })),
            HttpServerError: () =>
              Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "invalid" }, { status: 400 })),
          }),
        ),
      ),
      HttpRouter.route("POST", "/rpc", rpc),
    ];
    const application = yield* HttpRouter.toHttpEffect(HttpRouter.addAll(routes));
    return application.pipe(Effect.orDie);
  });

export const SupervisorControlServer = {
  make: makeSupervisorControlApplication,
  middleware: (lifecycle: SupervisorLifecycle["Service"]) =>
    makeSupervisorControlMiddleware(lifecycle),
};

/**
 * Releases the fenced stop transaction after the response has been handed to
 * the platform adapter. The lifecycle-owned shutdown fiber performs teardown
 * independently; awaiting it in this request fiber would keep Node's active
 * response open while server.close waits for that same response to finish.
 */
export const makeSupervisorControlMiddleware =
  (lifecycle: SupervisorLifecycle["Service"]): HttpMiddleware.HttpMiddleware =>
  (self) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const response = yield* self;
      if (request.method === "POST" && request.url === "/stop" && response.status === 202) {
        yield* lifecycle.releaseStopResponse;
      }
      return response;
    });
