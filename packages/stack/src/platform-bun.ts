import { BunServices } from "@effect/platform-bun";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { fileURLToPath } from "node:url";
import { Effect, Exit, Layer, Scope } from "effect";
import type { PlatformFactory } from "./createStack.ts";
import {
  CONTROL_STATUS_PATH,
  ControlBindError,
  ControlProtocolError,
  ControlTransport,
  ControlTransportError,
  type ControlEndpoint,
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

const errorCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  if ("code" in cause && typeof cause.code === "string") return cause.code;
  if ("cause" in cause) return errorCode(cause.cause);
  return undefined;
};

const controlTransport: ControlTransport["Service"] = {
  bind: (endpoint: ControlEndpoint) =>
    Effect.gen(function* () {
      const parentScope = yield* Effect.scope;
      const serverScope = yield* Scope.fork(parentScope);
      const server = yield* BunHttpServer.make({
        hostname: endpoint.hostname,
        port: endpoint.port,
        disablePreemptiveShutdown: true,
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
      return {
        server,
        close: Scope.close(serverScope, Exit.void),
      };
    }),
  read: (endpoint: ControlEndpoint) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`http://127.0.0.1:${endpoint.port}${CONTROL_STATUS_PATH}`);
        if (!response.ok) throw new Error(`Control status request returned ${response.status}`);
        return await response.json();
      },
      catch: (cause) => {
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
