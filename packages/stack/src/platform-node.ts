import { NodeServices } from "@effect/platform-node";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer } from "node:http";
import * as Http from "node:http";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Scope, Schema } from "effect";
import { HttpServer } from "effect/unstable/http";
import type { PlatformFactory } from "./createStack.ts";
import {
  CONTROL_STATUS_PATH,
  CONTROL_STOP_PATH,
  ControlStopRequestSchema,
  type ControlStopRequest,
  ControlBindError,
  ControlProtocolError,
  ControlStopConflictError,
  ControlTransport,
  ControlTransportError,
  type ControlOwnerStatus,
  type ControlEndpoint,
  type ControlApplication,
} from "./managed/control.ts";

const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;

const errorCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  if ("code" in cause && typeof cause.code === "string") return cause.code;
  if ("cause" in cause) return errorCode(cause.cause);
  return undefined;
};

const isDefinitivelyUnreachable = (cause: unknown): boolean => {
  const code = errorCode(cause);
  return code === "ECONNREFUSED";
};

const closeControlServer = (server: Http.Server): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return Effect.void;
    }
    server.close((error) => resume(error === undefined ? Effect.void : Effect.die(error)));
    return Effect.void;
  });

const readError = (
  endpoint: ControlEndpoint,
  cause: unknown,
): ControlTransportError | ControlProtocolError => {
  if (
    cause instanceof SyntaxError ||
    (cause instanceof Error &&
      cause.message === `Control status response exceeded ${MAX_CONTROL_RESPONSE_BYTES} bytes`) ||
    (cause instanceof Error && cause.message.startsWith("Control status request returned"))
  ) {
    return new ControlProtocolError({ endpoint, cause });
  }
  if (isDefinitivelyUnreachable(cause)) {
    return new ControlTransportError({ endpoint, reason: "unreachable", cause });
  }
  return new ControlTransportError({ endpoint, reason: "transport", cause });
};

const controlTransport: ControlTransport["Service"] = {
  bind: (
    endpoint: ControlEndpoint,
    ownerStatus: () => ControlOwnerStatus,
    onStop: (request: ControlStopRequest) => "accepted" | "conflict" | "invalid",
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
                const status = decision === "accepted" ? 202 : decision === "conflict" ? 409 : 400;
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
        const handler = yield* NodeHttpServer.makeHandler(application.app, {
          scope,
        });
        rawServer.removeAllListeners("request");
        rawServer.on("request", handler);
        yield* Effect.callback<void, Error>((resume) => {
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
        }).pipe(
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
        yield* Scope.addFinalizer(scope, closeControlServer(rawServer));
        return { server, close: closeControlServer(rawServer) };
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
  read: (endpoint: ControlEndpoint) =>
    Effect.callback<unknown, unknown>((resume) => {
      let response: Http.IncomingMessage | undefined;
      let onData: ((chunk: string) => void) | undefined;
      let onEnd: (() => void) | undefined;
      let onResponseError: ((cause: Error) => void) | undefined;
      let onResponseAborted: (() => void) | undefined;
      let onResponseClose: (() => void) | undefined;
      let settled = false;
      let cleanup = () => {};
      let dispose = () => {};
      const finish = (effect: Effect.Effect<unknown, unknown>, shouldDispose = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (shouldDispose) dispose();
        resume(effect);
      };
      const onRequestError = (cause: Error) => finish(Effect.fail(cause), true);
      const request = Http.request(
        {
          host: "127.0.0.1",
          port: endpoint.port,
          path: CONTROL_STATUS_PATH,
          method: "GET",
          // One-shot connection: a pooled keep-alive connection would let a
          // closed listener keep answering status probes while the probes
          // themselves keep the connection alive.
          agent: false,
        },
        (incoming) => {
          response = incoming;
          let body = "";
          let bodyBytes = 0;
          let ended = false;
          let responseAborted = false;
          onData = (chunk) => {
            bodyBytes += Buffer.byteLength(chunk, "utf8");
            if (bodyBytes > MAX_CONTROL_RESPONSE_BYTES) {
              finish(
                Effect.fail(
                  new Error(`Control status response exceeded ${MAX_CONTROL_RESPONSE_BYTES} bytes`),
                ),
                true,
              );
              return;
            }
            body += chunk;
          };
          onEnd = () => {
            ended = true;
            if ((incoming.statusCode ?? 500) < 200 || (incoming.statusCode ?? 500) >= 300) {
              finish(
                Effect.fail(
                  new Error(`Control status request returned ${incoming.statusCode ?? 500}`),
                ),
                true,
              );
              return;
            }
            try {
              finish(Effect.succeed(JSON.parse(body)));
            } catch (cause) {
              finish(Effect.fail(cause), true);
            }
          };
          onResponseError = (cause) => finish(Effect.fail(cause), true);
          onResponseAborted = () => {
            responseAborted = true;
          };
          onResponseClose = () => {
            if (responseAborted || !ended) {
              finish(Effect.fail(new Error("Control status response closed before end")), true);
            }
          };
          incoming.setEncoding("utf8");
          incoming.on("data", onData);
          incoming.once("end", onEnd);
          incoming.once("error", onResponseError);
          incoming.once("aborted", onResponseAborted);
          incoming.once("close", onResponseClose);
        },
      );
      dispose = () => {
        response?.destroy();
        request.destroy();
      };
      cleanup = () => {
        request.removeListener("error", onRequestError);
        if (response !== undefined) {
          if (onData !== undefined) response.removeListener("data", onData);
          if (onEnd !== undefined) response.removeListener("end", onEnd);
          if (onResponseError !== undefined) response.removeListener("error", onResponseError);
          if (onResponseAborted !== undefined) {
            response.removeListener("aborted", onResponseAborted);
          }
          if (onResponseClose !== undefined) response.removeListener("close", onResponseClose);
        }
      };
      request.once("error", onRequestError);
      request.end();
      return Effect.callback<void>((resumeCancellation) => {
        const onClose = () => {
          cleanup();
          resumeCancellation(Effect.void);
        };
        settled = true;
        request.once("close", onClose);
        dispose();
        return Effect.sync(() => {
          request.removeListener("close", onClose);
          cleanup();
        });
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: 500,
        orElse: () => Effect.fail(new Error("Control status request timed out")),
      }),
      Effect.mapError((cause) => readError(endpoint, cause)),
    ),
  requestStop: (endpoint: ControlEndpoint, stopRequest: ControlStopRequest) =>
    Effect.callback<void, unknown>((resume) => {
      let response: Http.IncomingMessage | undefined;
      let onEnd: (() => void) | undefined;
      let onResponseError: ((cause: Error) => void) | undefined;
      let onResponseAborted: (() => void) | undefined;
      let onResponseClose: (() => void) | undefined;
      let settled = false;
      let cleanup = () => {};
      let dispose = () => {};
      const finish = (effect: Effect.Effect<void, unknown>, shouldDispose = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (shouldDispose) dispose();
        resume(effect);
      };
      const onRequestError = (cause: Error) => finish(Effect.fail(cause), true);
      const request = Http.request(
        {
          host: endpoint.hostname,
          port: endpoint.port,
          path: CONTROL_STOP_PATH,
          method: "POST",
          agent: false,
        },
        (incoming) => {
          response = incoming;
          let ended = false;
          let responseAborted = false;
          onEnd = () => {
            ended = true;
            const status = incoming.statusCode ?? 500;
            if (status >= 200 && status < 300) {
              finish(Effect.void);
            } else if (status === 409) {
              finish(Effect.fail(new ControlStopConflictError({ endpoint })), true);
            } else {
              finish(Effect.fail(new Error(`Control stop request returned ${status}`)), true);
            }
          };
          onResponseError = (cause) => finish(Effect.fail(cause), true);
          onResponseAborted = () => {
            responseAborted = true;
          };
          onResponseClose = () => {
            if (responseAborted || !ended) {
              finish(Effect.fail(new Error("Control stop response closed before end")), true);
            }
          };
          incoming.once("end", onEnd);
          incoming.once("error", onResponseError);
          incoming.once("aborted", onResponseAborted);
          incoming.once("close", onResponseClose);
          incoming.resume();
        },
      );
      dispose = () => {
        response?.destroy();
        request.destroy();
      };
      cleanup = () => {
        request.removeListener("error", onRequestError);
        if (response !== undefined) {
          if (onEnd !== undefined) response.removeListener("end", onEnd);
          if (onResponseError !== undefined) response.removeListener("error", onResponseError);
          if (onResponseAborted !== undefined) {
            response.removeListener("aborted", onResponseAborted);
          }
          if (onResponseClose !== undefined) response.removeListener("close", onResponseClose);
        }
      };
      request.once("error", onRequestError);
      const body = JSON.stringify(stopRequest);
      request.setHeader("content-type", "application/json");
      request.setHeader("content-length", Buffer.byteLength(body));
      request.end(body);
      return Effect.callback<void>((resumeCancellation) => {
        const onClose = () => {
          cleanup();
          resumeCancellation(Effect.void);
        };
        settled = true;
        request.once("close", onClose);
        dispose();
        return Effect.sync(() => {
          request.removeListener("close", onClose);
          cleanup();
        });
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: 500,
        orElse: () => Effect.fail(new Error("Control stop request timed out")),
      }),
      Effect.mapError((cause) =>
        cause instanceof ControlStopConflictError
          ? cause
          : new ControlTransportError({
              endpoint,
              reason: isDefinitivelyUnreachable(cause) ? "unreachable" : "transport",
              cause,
            }),
      ),
    ),
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
