import { NodeServices } from "@effect/platform-node";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer } from "node:http";
import * as Http from "node:http";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import type { PlatformFactory } from "./createStack.ts";
import {
  CONTROL_STATUS_PATH,
  CONTROL_STOP_PATH,
  ControlBindError,
  ControlProtocolError,
  ControlTransport,
  ControlTransportError,
  type ControlOwnerStatus,
  type ControlEndpoint,
} from "./managed/control.ts";
const errorCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  if ("code" in cause && typeof cause.code === "string") return cause.code;
  if ("cause" in cause) return errorCode(cause.cause);
  return undefined;
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
  const code = errorCode(cause);
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    (cause instanceof Error && cause.message === "Control status request timed out")
  ) {
    return new ControlTransportError({ endpoint, reason: "unreachable", cause });
  }
  if (
    cause instanceof SyntaxError ||
    (cause instanceof Error &&
      cause.message.startsWith("Control status request returned") &&
      !cause.message.endsWith(" 404"))
  ) {
    return new ControlProtocolError({ endpoint, cause });
  }
  if (cause instanceof Error && cause.message.endsWith(" 404")) {
    return new ControlTransportError({ endpoint, reason: "unreachable", cause });
  }
  return new ControlTransportError({ endpoint, reason: "transport", cause });
};

const controlTransport: ControlTransport["Service"] = {
  bind: (endpoint: ControlEndpoint, ownerStatus: () => ControlOwnerStatus, onStop: () => void) => {
    const rawServer = createServer((request, response) => {
      if (request.url === CONTROL_STOP_PATH && request.method === "POST") {
        if (rawServer.listenerCount("request") > 1) return;
        onStop();
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url !== CONTROL_STATUS_PATH || request.method !== "GET") {
        if (rawServer.listenerCount("request") > 1) return;
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Stack supervisor is starting" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(ownerStatus()));
    });
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
      let settled = false;
      let cleanup = () => {};
      const finish = (effect: Effect.Effect<unknown, unknown>) => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(effect);
      };
      const onError = (cause: Error) => finish(Effect.fail(cause));
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
          onData = (chunk) => {
            body += chunk;
          };
          onEnd = () => {
            if ((incoming.statusCode ?? 500) < 200 || (incoming.statusCode ?? 500) >= 300) {
              finish(
                Effect.fail(
                  new Error(`Control status request returned ${incoming.statusCode ?? 500}`),
                ),
              );
              return;
            }
            try {
              finish(Effect.succeed(JSON.parse(body)));
            } catch (cause) {
              finish(Effect.fail(cause));
            }
          };
          incoming.setEncoding("utf8");
          incoming.on("data", onData);
          incoming.once("end", onEnd);
        },
      );
      cleanup = () => {
        request.removeListener("error", onError);
        request.setTimeout(0);
        if (response !== undefined) {
          if (onData !== undefined) response.removeListener("data", onData);
          if (onEnd !== undefined) response.removeListener("end", onEnd);
        }
      };
      request.setTimeout(500, () => request.destroy(new Error("Control status request timed out")));
      request.once("error", onError);
      request.end();
      return Effect.sync(() => {
        settled = true;
        cleanup();
        response?.destroy();
        request.destroy();
      });
    }).pipe(Effect.mapError((cause) => readError(endpoint, cause))),
  requestStop: (endpoint: ControlEndpoint) =>
    Effect.callback<void, unknown>((resume) => {
      let response: Http.IncomingMessage | undefined;
      let onEnd: (() => void) | undefined;
      let settled = false;
      let cleanup = () => {};
      const finish = (effect: Effect.Effect<void, unknown>) => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(effect);
      };
      const onError = (cause: Error) => finish(Effect.fail(cause));
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
          onEnd = () => {
            if ((incoming.statusCode ?? 500) >= 200 && (incoming.statusCode ?? 500) < 300) {
              finish(Effect.void);
            } else {
              finish(
                Effect.fail(
                  new Error(`Control stop request returned ${incoming.statusCode ?? 500}`),
                ),
              );
            }
          };
          incoming.resume();
          incoming.once("end", onEnd);
        },
      );
      cleanup = () => {
        request.removeListener("error", onError);
        request.setTimeout(0);
        if (response !== undefined && onEnd !== undefined) {
          response.removeListener("end", onEnd);
        }
      };
      request.setTimeout(500, () => request.destroy(new Error("Control stop request timed out")));
      request.once("error", onError);
      request.end();
      return Effect.sync(() => {
        settled = true;
        cleanup();
        response?.destroy();
        request.destroy();
      });
    }).pipe(
      Effect.mapError(
        (cause) => new ControlTransportError({ endpoint, reason: "unreachable", cause }),
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
