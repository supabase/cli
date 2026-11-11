import type { Socket } from "node:net";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { describe, expect, test } from "vitest";
import { Deferred, Effect, Fiber, Predicate } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { createApiClient as createNodeApiClient } from "./node.ts";

const startApiServer = Effect.gen(function* () {
  const sockets = new Set<Socket>();
  const connection = yield* Deferred.make<Socket>();
  const server = yield* HttpServer.HttpServer;
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const socket = NodeHttpServerRequest.toIncomingMessage(request).socket;
      if (!sockets.has(socket)) {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        yield* Deferred.succeed(connection, socket);
      }
      return HttpServerResponse.text("[]", { contentType: "application/json" });
    }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const socket of sockets) {
        socket.destroy();
      }
    }),
  );

  const address = server.address;
  if (Predicate.isTagged(address, "UnixPathAddress")) {
    return yield* Effect.die("Expected the API test server to have a TCP address");
  }
  return {
    sockets,
    connected: Deferred.await(connection),
    url: `http://127.0.0.1:${address.port}`,
  };
});

const socketClosed = (socket: Socket) =>
  Effect.callback<void>((resume) => {
    if (socket.destroyed) {
      resume(Effect.void);
      return;
    }
    const onClose = () => resume(Effect.void);
    socket.once("close", onClose);
    return Effect.sync(() => socket.off("close", onClose));
  });

describe("Node client lifecycle", () => {
  test("disposes the Node dispatcher and rejects operations after disposal", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { connected, url } = yield* startApiServer;
        const client = yield* Effect.acquireRelease(
          Effect.promise(() => createNodeApiClient({ baseUrl: url, accessToken: "test-token" })),
          (client) => Effect.promise(() => client.dispose()),
        );
        yield* Effect.promise(() => expect(client.v1.listAllProjects()).resolves.toEqual([]));

        const socket = yield* connected;
        expect(socket.destroyed).toBe(false);
        const closed = yield* Effect.forkChild(socketClosed(socket), { startImmediately: true });

        yield* Effect.promise(() => client.dispose());
        yield* Fiber.join(closed);
        expect(socket.destroyed).toBe(true);
        yield* Effect.promise(() => expect(client.v1.listAllProjects()).rejects.toThrow());
      }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
    ));

  test("cleans up when client initialization fails", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { sockets, connected, url } = yield* startApiServer;
        yield* Effect.promise(() =>
          expect(
            createNodeApiClient(
              { baseUrl: url, accessToken: "test-token" },
              {
                transformClient: (client) =>
                  Effect.gen(function* () {
                    yield* HttpClient.get("/initialization-check").pipe(
                      Effect.flatMap((response) => response.text),
                      Effect.orDie,
                      Effect.provideService(HttpClient.HttpClient, client),
                    );
                    const socket = yield* connected;
                    if (sockets.size !== 1 || socket.destroyed) {
                      return yield* Effect.die("initialization request socket was not open");
                    }
                    return yield* Effect.die("client initialization failed");
                  }),
              },
            ),
          ).rejects.toThrow("client initialization failed"),
        );

        const socket = yield* connected;
        yield* socketClosed(socket);
        expect(socket.destroyed).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
    ));
});
