import { BunServices } from "@effect/platform-bun";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { fileURLToPath } from "node:url";
import { Effect, Exit, Layer, Scope, Schema } from "effect";
import { HttpEffect, HttpServer } from "effect/unstable/http";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { PlatformFactory } from "./createStack.ts";
import {
  CONTROL_STATUS_PATH,
  CONTROL_STOP_PATH,
  ControlStopRequestSchema,
  ControlBindError,
  ControlProtocolError,
  ControlTransport,
  ControlTransportError,
  type ControlOwnerStatus,
  type ControlStopRequest,
  type ControlEndpoint,
  type ControlApplication,
} from "./managed/control.ts";
const errorCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  if ("code" in cause && typeof cause.code === "string") return cause.code;
  if ("cause" in cause) return errorCode(cause.cause);
  return undefined;
};

const isDefinitivelyUnreachable = (cause: unknown): boolean => {
  const code = errorCode(cause);
  return code === "ECONNREFUSED" || code === "ConnectionRefused";
};

const controlTransport: ControlTransport["Service"] = {
  bind: (
    endpoint: ControlEndpoint,
    ownerStatus: () => ControlOwnerStatus,
    onStop: (request: ControlStopRequest) => "accepted" | "conflict" | "invalid",
    application?: ControlApplication,
  ) =>
    // Bun.serve starts synchronously inside BunHttpServer.make, before that
    // constructor yields to register its scope finalizer. Keep only this
    // acquisition window uninterruptible; request handling and listener close
    // remain governed by the normal scope and interruption semantics.
    Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        const parentScope = yield* Effect.scope;
        if (application !== undefined) {
          const webHandler = HttpEffect.toWebHandler(application.app, application.middleware);
          const handler = (request: Request) => webHandler(request);
          const server = yield* Effect.try({
            try: () =>
              Bun.serve({
                hostname: endpoint.hostname,
                port: endpoint.port,
                idleTimeout: 0,
                fetch: handler,
              }),
            catch: (cause) =>
              new ControlBindError({
                endpoint,
                reason: errorCode(cause) === "EADDRINUSE" ? "in-use" : "failed",
                cause,
              }),
          });
          const close = yield* Effect.cached(
            Effect.tryPromise({
              try: () => Promise.resolve(server.stop(false)),
              catch: (cause) => cause,
            }).pipe(Effect.asVoid, Effect.orDie),
          );
          const service = HttpServer.make({
            address: {
              _tag: "TcpAddress",
              hostname: endpoint.hostname,
              port: server.port ?? endpoint.port,
            },
            serve: () => Effect.void,
          });
          yield* Scope.addFinalizer(parentScope, close);
          return { server: service, close };
        }
        const serverScope = yield* Scope.fork(parentScope);
        const server = yield* BunHttpServer.make({
          hostname: endpoint.hostname,
          port: endpoint.port,
          // Stack lifecycle requests can legitimately take up to the configured
          // readiness deadline. Bun's 10-second default would otherwise close
          // the control connection while the stack continues starting.
          idleTimeout: 0,
          disablePreemptiveShutdown: true,
          ...(application === undefined
            ? {
                routes: {
                  [CONTROL_STATUS_PATH]: {
                    GET: () =>
                      new Response(JSON.stringify(ownerStatus()), {
                        status: 200,
                        headers: { "content-type": "application/json" },
                      }),
                  },
                },
              }
            : {}),
        }).pipe(
          Scope.provide(serverScope),
          Effect.catchDefect((cause) =>
            Effect.fail(
              new ControlBindError({
                endpoint,
                reason: errorCode(cause) === "EADDRINUSE" ? "in-use" : "failed",
                cause,
              }),
            ),
          ),
        );
        yield* (
          application === undefined
            ? server.serve(
                Effect.gen(function* () {
                  const request = yield* HttpServerRequest.HttpServerRequest;
                  if (request.url === CONTROL_STOP_PATH && request.method === "POST") {
                    let stopRequest: ControlStopRequest;
                    try {
                      stopRequest = Schema.decodeUnknownSync(ControlStopRequestSchema)(
                        yield* request.json,
                      );
                    } catch {
                      return HttpServerResponse.jsonUnsafe(
                        { error: "Invalid stop request" },
                        { status: 400 },
                      );
                    }
                    const decision = onStop(stopRequest);
                    const status =
                      decision === "accepted" ? 202 : decision === "conflict" ? 409 : 400;
                    return HttpServerResponse.jsonUnsafe(
                      decision === "accepted" ? { ok: true } : { error: decision },
                      { status },
                    );
                  }
                  return HttpServerResponse.jsonUnsafe(
                    { error: "Stack supervisor is starting" },
                    { status: 503 },
                  );
                }),
              )
            : Effect.void
        ).pipe(Scope.provide(serverScope));
        return {
          server,
          close: Scope.close(serverScope, Exit.void),
        };
      }),
    ),
  read: (endpoint: ControlEndpoint) =>
    Effect.tryPromise({
      try: (signal) =>
        fetch(`http://127.0.0.1:${endpoint.port}${CONTROL_STATUS_PATH}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
          // One-shot connection: a pooled keep-alive connection would let a
          // closed listener keep answering status probes while the probes
          // themselves keep the connection alive.
          headers: { connection: "close" },
        }).then((response) => {
          if (!response.ok) throw new Error(`Control status request returned ${response.status}`);
          return response.json();
        }),
      catch: (cause) => {
        if (
          cause instanceof SyntaxError ||
          (cause instanceof Error && cause.message.startsWith("Control status request returned"))
        ) {
          return new ControlProtocolError({ endpoint, cause });
        }
        return new ControlTransportError({
          endpoint,
          reason: isDefinitivelyUnreachable(cause) ? "unreachable" : "transport",
          cause,
        });
      },
    }),
  requestStop: (endpoint: ControlEndpoint, stopRequest: ControlStopRequest) =>
    Effect.tryPromise({
      try: (signal) =>
        fetch(`http://127.0.0.1:${endpoint.port}${CONTROL_STOP_PATH}`, {
          method: "POST",
          signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
          headers: {
            connection: "close",
            "content-type": "application/json",
          },
          body: JSON.stringify(stopRequest),
        }).then((response) => {
          if (!response.ok) throw new Error(`Control stop request returned ${response.status}`);
        }),
      catch: (cause) =>
        new ControlTransportError({
          endpoint,
          reason: isDefinitivelyUnreachable(cause) ? "unreachable" : "transport",
          cause,
        }),
    }),
};

export const controlTransportLayer = Layer.succeed(ControlTransport, controlTransport);

export const platformFactory: PlatformFactory = ({ apiPort, releaseApiPort }) =>
  Layer.mergeAll(
    BunServices.layer,
    Layer.unwrap(releaseApiPort.pipe(Effect.as(BunHttpServer.layer({ port: apiPort })))),
  );

/** Internal source-mode child target. Compiled CLI dispatch still uses the daemon-bun export. */
export const daemonEntryPoint = fileURLToPath(new URL("./daemon-bun.ts", import.meta.url));
