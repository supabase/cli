import { NodeServices } from "@effect/platform-node";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The control server owns the native Node HTTP listener at this platform boundary.
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Scope, Schema } from "effect";
import { HttpServer } from "effect/unstable/http";
import type { PlatformFactory } from "./createStack.ts";
import { readControlOwner } from "./ControlHttpReader.ts";
import { requestControlStop } from "./ControlStopClient.ts";
import { errorCode } from "./error-code.ts";
import { STACK_RPC_PATH } from "./StackRpc.ts";
import {
  CONTROL_STATUS_PATH,
  CONTROL_STOP_PATH,
  ControlStopRequestSchema,
  type ControlStopRequest,
  ControlBindError,
  ControlTransport,
  type ControlOwnerStatus,
  type ControlEndpoint,
  type ControlApplication,
} from "./managed/control.ts";

const closeControlServer = (
  server: Server,
  interruptRpcRequests: () => void = () => {},
): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return Effect.void;
    }
    server.close((error) => resume(error === undefined ? Effect.void : Effect.die(error)));
    interruptRpcRequests();
    server.closeIdleConnections();
    return Effect.void;
  });

const controlTransport: ControlTransport["Service"] = {
  bind: (
    endpoint: ControlEndpoint,
    ownerStatus: () => ControlOwnerStatus,
    onStop: (request: ControlStopRequest) => "accepted" | "conflict" | "busy" | "invalid",
    application?: ControlApplication,
  ) => {
    const rawServer = createServer(
      application === undefined
        ? (request, response) => {
            if (request.url === CONTROL_STOP_PATH && request.method === "POST") {
              const chunks: Buffer[] = [];
              let size = 0;
              request.on("data", (chunk: Buffer) => {
                size += chunk.byteLength;
                if (size <= 16 * 1024) chunks.push(chunk);
              });
              request.once("end", () => {
                let decoded: ControlStopRequest | undefined;
                try {
                  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                  decoded = Schema.decodeUnknownSync(ControlStopRequestSchema)(parsed);
                } catch {
                  response.writeHead(400, { "content-type": "application/json" });
                  response.end(JSON.stringify({ error: "Invalid stop request" }));
                  return;
                }
                const decision = onStop(decoded);
                const status =
                  decision === "accepted"
                    ? 202
                    : decision === "conflict"
                      ? 409
                      : decision === "busy"
                        ? 423
                        : 400;
                response.writeHead(status, { "content-type": "application/json" });
                response.end(
                  JSON.stringify(decision === "accepted" ? { ok: true } : { error: decision }),
                );
              });
              return;
            }
            if (request.url !== CONTROL_STATUS_PATH || request.method !== "GET") {
              response.writeHead(503, { "content-type": "application/json" });
              response.end(JSON.stringify({ error: "Stack supervisor is starting" }));
              return;
            }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(ownerStatus()));
          }
        : undefined,
    );
    if (application !== undefined) {
      return Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const activeRpcRequests = new Set<() => void>();
        const interruptRpcRequests = () => {
          for (const interrupt of activeRpcRequests) interrupt();
        };
        const close = closeControlServer(rawServer, interruptRpcRequests);
        const handler = yield* NodeHttpServer.makeHandler(application.app, {
          scope,
        });
        rawServer.removeAllListeners("request");
        rawServer.on("request", (request, response) => {
          if (request.url === STACK_RPC_PATH || request.url === `${STACK_RPC_PATH}/`) {
            const interrupt = () => response.destroy();
            activeRpcRequests.add(interrupt);
            const release = () => activeRpcRequests.delete(interrupt);
            response.once("finish", release);
            response.once("close", release);
          }
        });
        rawServer.on("request", handler);
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            yield* restore(
              Effect.callback<void, Error>((resume) => {
                const onError = (cause: Error) => {
                  rawServer.off("error", onError);
                  resume(Effect.fail(cause));
                };
                rawServer.once("error", onError);
                rawServer.listen({ host: endpoint.hostname, port: endpoint.port }, () => {
                  rawServer.off("error", onError);
                  resume(Effect.void);
                });
                return Effect.sync(() => {
                  rawServer.off("error", onError);
                  if (rawServer.listening) rawServer.close();
                  else rawServer.once("listening", () => rawServer.close());
                });
              }),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new ControlBindError({
                    endpoint,
                    reason: errorCode(cause) === "EADDRINUSE" ? "in-use" : "failed",
                    cause,
                  }),
              ),
            );
            const boundAddress = rawServer.address();
            const server = HttpServer.make({
              address: {
                _tag: "TcpAddress",
                hostname: endpoint.hostname,
                port:
                  typeof boundAddress === "object" && boundAddress !== null
                    ? boundAddress.port
                    : endpoint.port,
              },
              serve: () => Effect.void,
            });
            yield* Scope.addFinalizer(scope, close);
            return { server, close };
          }),
        );
      });
    }
    return NodeHttpServer.make(() => rawServer, {
      host: endpoint.hostname,
      port: endpoint.port,
      disablePreemptiveShutdown: true,
    }).pipe(
      Effect.map((server) => ({ server, close: closeControlServer(rawServer) })),
      Effect.mapError(
        (cause) =>
          new ControlBindError({
            endpoint,
            reason: errorCode(cause) === "EADDRINUSE" ? "in-use" : "failed",
            cause,
          }),
      ),
    );
  },
  read: readControlOwner,
  requestStop: requestControlStop,
};

export const controlTransportLayer = Layer.succeed(ControlTransport, controlTransport);

export const platformFactory: PlatformFactory = ({ apiPort, releaseApiPort }) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.unwrap(
      releaseApiPort.pipe(
        Effect.as(NodeHttpServer.layer(() => createServer(), { port: apiPort }).pipe(Layer.orDie)),
      ),
    ),
  );

/** Internal child-process target. It is intentionally absent from package exports. */
export const daemonEntryPoint = fileURLToPath(new URL("./daemon-node.ts", import.meta.url));
