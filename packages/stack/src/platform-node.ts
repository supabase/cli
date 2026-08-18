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
    Effect.tryPromise({
      try: async () => {
        const requestStatus = (host: string) =>
          new Promise<unknown>((resolve, reject) => {
            const request = Http.request(
              {
                host,
                port: endpoint.port,
                path: CONTROL_STATUS_PATH,
                method: "GET",
                // One-shot connection: a pooled keep-alive connection would
                // let a closed listener keep answering status probes while
                // the probes themselves keep the connection alive.
                agent: false,
              },
              (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                  body += chunk;
                });
                response.on("end", () => {
                  if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
                    reject(
                      new Error(`Control status request returned ${response.statusCode ?? 500}`),
                    );
                    return;
                  }
                  try {
                    resolve(JSON.parse(body));
                  } catch (cause) {
                    reject(cause);
                  }
                });
              },
            );
            request.setTimeout(500, () =>
              request.destroy(new Error("Control status request timed out")),
            );
            request.once("error", reject);
            request.end();
          });
        return await requestStatus("127.0.0.1");
      },
      catch: (cause) => {
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
      },
    }),
  requestStop: (endpoint: ControlEndpoint) =>
    Effect.tryPromise({
      try: async () => {
        await new Promise<void>((resolve, reject) => {
          const request = Http.request(
            {
              host: endpoint.hostname,
              port: endpoint.port,
              path: CONTROL_STOP_PATH,
              method: "POST",
              agent: false,
            },
            (response) => {
              response.resume();
              response.once("end", () => {
                if ((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300) {
                  resolve();
                } else {
                  reject(new Error(`Control stop request returned ${response.statusCode ?? 500}`));
                }
              });
            },
          );
          request.setTimeout(500, () =>
            request.destroy(new Error("Control stop request timed out")),
          );
          request.once("error", reject);
          request.end();
        });
      },
      catch: (cause) => new ControlTransportError({ endpoint, reason: "unreachable", cause }),
    }),
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
