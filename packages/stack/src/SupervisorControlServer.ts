import { Effect, Layer } from "effect";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import { ControlStopRequestSchema } from "./DaemonProtocol.ts";
import { matchesStackRpcFence, StackRpc } from "./StackRpc.ts";
import {
  StackLaunchUpdater,
  StackRpcHandlers,
  type StackLaunchUpdater as StackLaunchUpdaterService,
} from "./StackRpcHandlers.ts";
import { SupervisorSession } from "./SupervisorSession.ts";

/** Builds the complete static supervisor application before listener binding. */
export const makeSupervisorControlApplication = (
  session: SupervisorSession["Service"],
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
      Effect.provide(handlers.pipe(Layer.provide(Layer.succeed(SupervisorSession, session)))),
      Effect.provide(RpcSerialization.layerNdjson),
    );
    const fencedRpc = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const status = yield* session.currentStatus;
      if (
        !matchesStackRpcFence(request.headers, {
          ownershipId: status.ownershipId,
          ownerSessionId: status.ownerSessionId,
        })
      ) {
        // These headers fence a client to the observed owner; they are not an
        // authentication mechanism and carry no secret material.
        return HttpServerResponse.jsonUnsafe({ error: "rpc-fence-mismatch" }, { status: 409 });
      }
      return yield* rpc;
    });
    const routes = [
      HttpRouter.route(
        "GET",
        "/owner",
        session.currentStatus.pipe(Effect.map(HttpServerResponse.jsonUnsafe)),
      ),
      HttpRouter.route(
        "POST",
        "/stop",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.schemaBodyJson(ControlStopRequestSchema);
          const status = yield* session.currentStatus;
          if (
            request.ownershipId !== status.ownershipId ||
            request.ownerSessionId !== status.ownerSessionId
          ) {
            return HttpServerResponse.jsonUnsafe({ error: "conflict" }, { status: 409 });
          }
          // Submit ownership of the stop transaction before returning 202. The
          // listener closes gracefully after the response is flushed.
          yield* session.submitShutdownWithIntent(request.intent);
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
      HttpRouter.route("POST", "/rpc", fencedRpc),
    ];
    const application = yield* HttpRouter.toHttpEffect(HttpRouter.addAll(routes));
    return application.pipe(Effect.catchTag("HttpServerError", HttpServerRespondable.toResponse));
  });

export const SupervisorControlServer = {
  make: makeSupervisorControlApplication,
};
