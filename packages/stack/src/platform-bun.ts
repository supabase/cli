// oxlint-disable effecttsgo/async-function -- Bun's native fetch and ReadableStream callbacks are Promise-based host boundaries.
import * as BunServices from "@effect/platform-bun/BunServices";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { fileURLToPath } from "node:url";
import { Data, Effect, Exit, Layer, Scope } from "effect";
import {
  HttpEffect,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import type { PlatformFactory } from "./createStack.ts";
import { readControlOwner } from "./ControlHttpReader.ts";
import { requestControlStop } from "./ControlStopClient.ts";
import { errorCode } from "./error-code.ts";
import { STACK_RPC_PATH } from "./StackRpc.ts";
import {
  CONTROL_STATUS_PATH,
  CONTROL_STOP_PATH,
  ControlStopRequestSchema,
  ControlBindError,
  ControlTransport,
  type ControlOwnerStatus,
  type ControlStopRequest,
  type ControlEndpoint,
  type ControlApplication,
} from "./managed/control.ts";

class BunServerStopError extends Data.TaggedError("BunServerStopError")<{
  readonly cause: unknown;
}> {}
const controlTransport: ControlTransport["Service"] = {
  bind: (
    endpoint: ControlEndpoint,
    ownerStatus: () => ControlOwnerStatus,
    onStop: (request: ControlStopRequest) => "accepted" | "conflict" | "busy" | "invalid",
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
          const webHandler = HttpEffect.toWebHandler(application.app);
          const activeRpcRequests = new Set<{ readonly interrupt: () => void }>();
          const handler = async (request: Request): Promise<Response> => {
            const path = new URL(request.url).pathname;
            if (path !== STACK_RPC_PATH && path !== `${STACK_RPC_PATH}/`) {
              return webHandler(request);
            }
            const controller = new AbortController();
            let cancelBody: (() => Promise<void>) | undefined;
            const onClientAbort = () => controller.abort(request.signal.reason);
            const active = {
              interrupt: () => {
                controller.abort();
                void cancelBody?.();
              },
            };
            const release = () => {
              request.signal.removeEventListener("abort", onClientAbort);
              activeRpcRequests.delete(active);
            };
            activeRpcRequests.add(active);
            request.signal.addEventListener("abort", onClientAbort, { once: true });
            if (request.signal.aborted) onClientAbort();
            try {
              const response = await webHandler(
                new Request(request, { signal: controller.signal }),
              );
              if (response.body === null) {
                release();
                return response;
              }
              const reader = response.body.getReader();
              cancelBody = () => reader.cancel();
              const body = new ReadableStream<Uint8Array>({
                pull: async (streamController) => {
                  try {
                    const next = await reader.read();
                    if (next.done) {
                      release();
                      streamController.close();
                    } else {
                      streamController.enqueue(next.value);
                    }
                  } catch (cause) {
                    release();
                    streamController.error(cause);
                  }
                },
                cancel: async (reason) => {
                  release();
                  await reader.cancel(reason);
                },
              });
              return new Response(body, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              });
            } catch (cause) {
              release();
              throw cause;
            }
          };
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
              try: () => {
                const stopped = server.stop(false);
                for (const request of activeRpcRequests) request.interrupt();
                return stopped;
              },
              catch: (cause) => new BunServerStopError({ cause }),
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
                    return yield* HttpServerRequest.schemaBodyJson(ControlStopRequestSchema).pipe(
                      Effect.map((stopRequest) => {
                        const decision = onStop(stopRequest);
                        const status =
                          decision === "accepted"
                            ? 202
                            : decision === "conflict"
                              ? 409
                              : decision === "busy"
                                ? 423
                                : 400;
                        return HttpServerResponse.jsonUnsafe(
                          decision === "accepted" ? { ok: true } : { error: decision },
                          { status },
                        );
                      }),
                      Effect.catchTags({
                        SchemaError: () =>
                          Effect.succeed(
                            HttpServerResponse.jsonUnsafe(
                              { error: "Invalid stop request" },
                              { status: 400 },
                            ),
                          ),
                        HttpServerError: () =>
                          Effect.succeed(
                            HttpServerResponse.jsonUnsafe(
                              { error: "Invalid stop request" },
                              { status: 400 },
                            ),
                          ),
                      }),
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
  read: readControlOwner,
  requestStop: requestControlStop,
};

export const controlTransportLayer = Layer.succeed(ControlTransport, controlTransport);

export const platformFactory: PlatformFactory = ({ apiPort, releaseApiPort }) =>
  Layer.mergeAll(
    BunServices.layer,
    Layer.unwrap(releaseApiPort.pipe(Effect.as(BunHttpServer.layer({ port: apiPort })))),
  );

/** Internal source-mode child target. Compiled CLI dispatch still uses the daemon-bun export. */
export const daemonEntryPoint = fileURLToPath(new URL("./daemon-bun.ts", import.meta.url));
