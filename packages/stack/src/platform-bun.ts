import { BunServices } from "@effect/platform-bun";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { fileURLToPath } from "node:url";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
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

const controlTransport: ControlTransport["Service"] = {
  bind: (endpoint: ControlEndpoint, ownerStatus: () => ControlOwnerStatus, onStop: () => void) =>
    // Bun.serve starts synchronously inside BunHttpServer.make, before that
    // constructor yields to register its scope finalizer. Keep only this
    // acquisition window uninterruptible; request handling and listener close
    // remain governed by the normal scope and interruption semantics.
    Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        const parentScope = yield* Effect.scope;
        const serverScope = yield* Scope.fork(parentScope);
        const server = yield* BunHttpServer.make({
          hostname: endpoint.hostname,
          port: endpoint.port,
          disablePreemptiveShutdown: true,
          routes: {
            [CONTROL_STATUS_PATH]: {
              GET: () =>
                new Response(JSON.stringify(ownerStatus()), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
            },
          },
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
        yield* server
          .serve(
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              if (request.url === CONTROL_STOP_PATH && request.method === "POST") {
                onStop();
                return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 202 });
              }
              return HttpServerResponse.jsonUnsafe(
                { error: "Stack supervisor is starting" },
                { status: 503 },
              );
            }),
          )
          .pipe(Scope.provide(serverScope));
        return {
          server,
          close: Scope.close(serverScope, Exit.void),
        };
      }),
    ),
  read: (endpoint: ControlEndpoint) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`http://127.0.0.1:${endpoint.port}${CONTROL_STATUS_PATH}`, {
          signal: AbortSignal.timeout(500),
        });
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
  requestStop: (endpoint: ControlEndpoint) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`http://127.0.0.1:${endpoint.port}${CONTROL_STOP_PATH}`, {
          method: "POST",
          signal: AbortSignal.timeout(500),
        });
        if (!response.ok) throw new Error(`Control stop request returned ${response.status}`);
      },
      catch: (cause) => new ControlTransportError({ endpoint, reason: "unreachable", cause }),
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
