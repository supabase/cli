import { BunServices } from "@effect/platform-bun";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import type { PlatformFactory } from "./createStack.ts";
import {
  CONTROL_STATUS_PATH,
  ControlBindError,
  ControlProtocolError,
  ControlTransport,
  ControlTransportError,
  type ControlEndpoint,
  type ControlListener,
  type ControlOwnerStatus,
} from "./managed/control.ts";
import { UnixHttpClient, UnixHttpClientError } from "./UnixHttpClient.ts";

interface BunUnixRequestInit extends RequestInit {
  readonly unix: string;
}

export const unixHttpClientLayer = Layer.succeed(UnixHttpClient, {
  request: (socketPath, path, init) =>
    Effect.tryPromise({
      try: () => {
        if (typeof socketPath === "string") {
          const requestInit: BunUnixRequestInit = { ...init, unix: socketPath };
          return fetch(`http://localhost${path}`, requestInit);
        }
        return fetch(`http://${socketPath.hostname}:${socketPath.port}${path}`, init);
      },
      catch: (cause) => new UnixHttpClientError({ socketPath, path, cause, reason: "transport" }),
    }),
});

const controlTransport: ControlTransport["Service"] = {
  bind: (endpoint: ControlEndpoint, status: () => ControlOwnerStatus) =>
    Effect.try({
      try: () => {
        const serve = (hostname: string) =>
          Bun.serve({
            hostname,
            port: endpoint.port,
            fetch: (request) => {
              if (
                request.method !== "GET" ||
                new URL(request.url).pathname !== CONTROL_STATUS_PATH
              ) {
                return new Response(JSON.stringify({ error: "not found" }), {
                  status: 404,
                  headers: { "content-type": "application/json" },
                });
              }
              return Response.json(status());
            },
          });
        const server = (() => {
          try {
            return serve(endpoint.hostname);
          } catch (cause) {
            const code =
              typeof cause === "object" && cause !== null && "code" in cause
                ? cause.code
                : undefined;
            if (code !== "EADDRNOTAVAIL") throw cause;
            return serve("127.0.0.1");
          }
        })();
        const listener: ControlListener = {
          close: Effect.promise(() => server.stop()),
        };
        return listener;
      },
      catch: (cause) => {
        const code =
          typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
        return new ControlBindError({
          endpoint,
          reason: code === "EADDRINUSE" ? "in-use" : "failed",
          cause,
        });
      },
    }),
  read: (endpoint: ControlEndpoint) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`http://127.0.0.1:${endpoint.port}${CONTROL_STATUS_PATH}`);
        if (!response.ok) throw new Error(`Control status request returned ${response.status}`);
        return await response.json();
      },
      catch: (cause) => {
        if (cause instanceof Error && cause.message.startsWith("Control status request returned")) {
          return new ControlProtocolError({ endpoint, cause });
        }
        return new ControlTransportError({ endpoint, reason: "unreachable", cause });
      },
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
