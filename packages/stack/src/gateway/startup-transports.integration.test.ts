import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Data, Deferred, Effect, Option, Predicate, Queue, Scope } from "effect";
import { connect as connectNet, createServer, type Server, type Socket } from "node:net";
import { makeHttpGateway } from "./HttpGateway.ts";
import { makeTcpGateway } from "./TcpGateway.ts";
import type { BackendEndpoint } from "./Gateway.ts";
import { bindHostListener } from "../supervisor/HostListener.ts";

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const closeServer = (server: Server): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (!server.listening) return resume(Effect.void);
    server.close(() => resume(Effect.void));
  });

const listen = (server: Server): Effect.Effect<number, Error, Scope.Scope> => {
  const connections = new Set<Socket>();
  const onConnection = (socket: Socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  };
  server.on("connection", onConnection);
  return Effect.acquireRelease(
    Effect.callback<number, Error>((resume) => {
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address === "object" && address !== null) resume(Effect.succeed(address.port));
      });
      return Effect.sync(() => server.close());
    }),
    () =>
      Effect.sync(() => {
        server.off("connection", onConnection);
        for (const socket of connections) socket.destroy();
      }).pipe(Effect.andThen(closeServer(server))),
  );
};

const socketAt = (port: number, allowHalfOpen = false): Effect.Effect<Socket, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<Socket, Error>((resume) => {
      const socket = connectNet({ port, host: "127.0.0.1", allowHalfOpen });
      socket.once("connect", () => resume(Effect.succeed(socket)));
      socket.once("error", (error) => resume(Effect.fail(error)));
      return Effect.sync(() => socket.destroy());
    }),
    (socket) => Effect.sync(() => socket.destroy()),
  );

class HeldSocketError extends Data.TaggedError("HeldSocketError")<{
  readonly message: string;
}> {}

describe("gateway startup transport adoption", () => {
  it.live("preserves TCP bytes sent before adoption while activation is delayed", () =>
    withPlatform(
      Effect.gen(function* () {
        const backend = createServer({ allowHalfOpen: true }, (socket) => {
          socket.on("data", (chunk) => {
            socket.write(chunk);
          });
          socket.once("end", () => socket.end());
        });
        const backendPort = yield* listen(backend);
        const listener = yield* bindHostListener("127.0.0.1", 0, "database");
        if (listener.binding.kind !== "tcp")
          return yield* Effect.die("database listener did not expose TCP binding");
        const address = listener.binding.server.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("TCP listener did not expose an address");
        const accepted = yield* Deferred.make<Socket>();
        listener.binding.server.once("connection", (socket) =>
          Deferred.doneUnsafe(accepted, Effect.succeed(socket)),
        );
        const activationStarted = yield* Deferred.make<void>();
        const releaseActivation = yield* Deferred.make<void>();
        const responseReady = yield* Deferred.make<Buffer>();
        const client = yield* socketAt(address.port);
        const serverSocket = yield* Deferred.await(accepted);
        const chunks: Buffer[] = [];
        client.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        client.once("end", () =>
          Deferred.doneUnsafe(responseReady, Effect.succeed(Buffer.concat(chunks))),
        );
        const fixture = Buffer.from("tcp-before-adoption");
        const buffered = yield* Deferred.make<void>();
        serverSocket.once("readable", () => Deferred.doneUnsafe(buffered, Effect.void));
        client.write(fixture);
        yield* Deferred.await(buffered);
        expect(serverSocket.readableLength).toBeGreaterThanOrEqual(fixture.byteLength);
        const gateway = yield* makeTcpGateway({
          listener,
          routes: [{ capability: "database", match: () => true }],
          activate: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(activationStarted, undefined);
              yield* Deferred.await(releaseActivation);
              return { capability: "database", endpoint: { host: "127.0.0.1", port: backendPort } };
            }),
        });
        yield* Deferred.await(activationStarted);
        expect(Option.isNone(yield* Deferred.poll(responseReady))).toBe(true);
        yield* Deferred.succeed(releaseActivation, undefined);
        client.end();
        expect((yield* Deferred.await(responseReady)).equals(fixture)).toBe(true);
        yield* gateway.close;
        yield* closeServer(backend);
      }),
    ),
  );

  it.live("contains errors during TCP activation without affecting other connections", () =>
    withPlatform(
      Effect.gen(function* () {
        const backend = createServer({ allowHalfOpen: true }, (socket) => {
          socket.on("data", (chunk) => socket.write(chunk));
        });
        const backendPort = yield* listen(backend);
        const listener = yield* bindHostListener("127.0.0.1", 0, "database");
        if (listener.binding.kind !== "tcp")
          return yield* Effect.die("database listener did not expose TCP binding");
        const address = listener.binding.server.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("TCP listener did not expose an address");
        const firstAccepted = yield* Deferred.make<Socket>();
        const secondAccepted = yield* Deferred.make<Socket>();
        listener.binding.server.once("connection", (socket) =>
          Deferred.doneUnsafe(firstAccepted, Effect.succeed(socket)),
        );
        const firstClient = yield* socketAt(address.port);
        const firstServer = yield* Deferred.await(firstAccepted);
        listener.binding.server.once("connection", (socket) =>
          Deferred.doneUnsafe(secondAccepted, Effect.succeed(socket)),
        );
        const secondClient = yield* socketAt(address.port);
        yield* Deferred.await(secondAccepted);
        const firstClosed = yield* Deferred.make<void>();
        const activationStarted = yield* Deferred.make<void>();
        const releaseActivation = yield* Deferred.make<void>();
        firstClient.on("error", () => undefined);
        firstClient.once("close", () => Deferred.doneUnsafe(firstClosed, Effect.void));
        const responseReady = yield* Deferred.make<Buffer>();
        secondClient.once("data", (chunk) =>
          Deferred.doneUnsafe(responseReady, Effect.succeed(Buffer.from(chunk))),
        );
        const gateway = yield* makeTcpGateway({
          listener,
          routes: [{ capability: "database", match: () => true }],
          activate: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(activationStarted, undefined);
              yield* Deferred.await(releaseActivation);
              return {
                capability: "database",
                endpoint: { host: "127.0.0.1", port: backendPort },
              };
            }),
        });
        yield* Deferred.await(activationStarted);
        firstServer.destroy(new HeldSocketError({ message: "held socket failed" }));
        yield* Deferred.await(firstClosed).pipe(Effect.timeout("5 seconds"));
        expect(Option.isNone(yield* Deferred.poll(responseReady))).toBe(true);
        yield* Deferred.succeed(releaseActivation, undefined);
        secondClient.write("unrelated-connection");
        expect((yield* Deferred.await(responseReady)).toString()).toBe("unrelated-connection");
        secondClient.destroy();
        yield* gateway.close;
      }),
    ),
  );

  it.live("preserves an early WebSocket handshake and payload across delayed adoption", () =>
    withPlatform(
      Effect.gen(function* () {
        const backend = createServer((socket) => {
          let upgraded = false;
          let pending = Buffer.alloc(0);
          const headerEnd = Buffer.from("\r\n\r\n");
          socket.on("data", (chunk) => {
            const bytes = Buffer.from(chunk);
            if (upgraded) {
              socket.write(bytes);
              return;
            }
            pending = Buffer.concat([pending, bytes]);
            const end = pending.indexOf(headerEnd);
            if (end < 0) return;
            upgraded = true;
            socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\nws-ready");
            const payload = pending.subarray(end + headerEnd.byteLength);
            if (payload.byteLength > 0) socket.write(payload);
            pending = Buffer.alloc(0);
          });
        });
        const backendPort = yield* listen(backend);
        const listener = yield* bindHostListener("127.0.0.1", 0, "api");
        if (listener.binding.kind !== "http")
          return yield* Effect.die("API listener did not expose HTTP binding");
        const address = listener.binding.server.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("HTTP listener did not expose an address");
        const client = yield* socketAt(address.port);
        const upgradeQueued = yield* Deferred.make<void>();
        const activationStarted = yield* Deferred.make<void>();
        const releaseActivation = yield* Deferred.make<void>();
        const responseReady = yield* Deferred.make<Buffer>();
        const output: Buffer[] = [];
        const preAdoptionPayload = Buffer.from("ws-before-adoption");
        let pingSent = false;
        listener.binding.server.once("upgrade", () =>
          Deferred.doneUnsafe(upgradeQueued, Effect.void),
        );
        client.on("data", (chunk) => {
          output.push(Buffer.from(chunk));
          const received = Buffer.concat(output);
          if (!pingSent && received.includes(Buffer.from("ws-ready"))) {
            pingSent = true;
            client.write("ws-ping");
          }
          if (received.includes(Buffer.from("ws-ping")))
            Deferred.doneUnsafe(responseReady, Effect.succeed(received));
        });
        client.write(
          Buffer.concat([
            Buffer.from(
              "GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
            ),
            preAdoptionPayload,
          ]),
        );
        yield* Deferred.await(upgradeQueued);
        const pendingEvents = listener.binding.pendingEvents;
        if (pendingEvents === undefined)
          return yield* Effect.die("HTTP listener did not expose pending events");
        const captured = yield* Queue.take(pendingEvents.queue);
        if (!Predicate.isTagged(captured, "upgrade"))
          return yield* Effect.die("upgrade event was not captured");
        if (captured.head.byteLength === 0 && captured.socket.readableLength === 0) {
          const bytesBuffered = yield* Deferred.make<void>();
          captured.socket.once("readable", () => Deferred.doneUnsafe(bytesBuffered, Effect.void));
          yield* Deferred.await(bytesBuffered);
        }
        expect(captured.head.byteLength + captured.socket.readableLength).toBeGreaterThan(0);
        Queue.offerUnsafe(pendingEvents.queue, captured);
        const gateway = yield* makeHttpGateway({
          listener,
          routes: [{ capability: "rest", match: (request) => request.path === "/socket" }],
          activate: () =>
            Deferred.succeed(activationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseActivation)),
              Effect.as({ capability: "rest", endpoint: { host: "127.0.0.1", port: backendPort } }),
            ),
        });
        yield* Deferred.await(activationStarted);
        expect(Option.isNone(yield* Deferred.poll(responseReady))).toBe(true);
        yield* Deferred.succeed(releaseActivation, undefined);
        const response = yield* Deferred.await(responseReady).pipe(Effect.timeout("5 seconds"));
        expect(response.toString()).toContain("101 Switching Protocols");
        expect(response.toString()).toContain(preAdoptionPayload.toString());
        expect(response.toString()).toContain("ws-ping");
        client.destroy();
        yield* gateway.close;
        yield* closeServer(backend);
      }),
    ),
  );

  it.live("forwards backend trailing bytes after a client WebSocket half-close", () =>
    withPlatform(
      Effect.gen(function* () {
        const backend = createServer({ allowHalfOpen: true }, (socket) => {
          let upgraded = false;
          socket.on("data", (chunk) => {
            if (!upgraded && Buffer.from(chunk).includes(Buffer.from("\r\n\r\n"))) {
              upgraded = true;
              socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
            }
          });
          socket.once("end", () => socket.end("trailingbytes"));
        });
        const backendPort = yield* listen(backend);
        const listener = yield* bindHostListener("127.0.0.1", 0, "api");
        if (listener.binding.kind !== "http")
          return yield* Effect.die("API listener did not expose HTTP binding");
        const address = listener.binding.server.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("HTTP listener did not expose an address");
        const client = yield* socketAt(address.port, true);
        const handshakeReady = yield* Deferred.make<void>();
        const responseReady = yield* Deferred.make<Buffer>();
        const output: Buffer[] = [];
        client.on("data", (chunk) => {
          output.push(Buffer.from(chunk));
          const response = Buffer.concat(output);
          if (response.includes(Buffer.from("101 Switching Protocols")))
            Deferred.doneUnsafe(handshakeReady, Effect.void);
          if (response.includes(Buffer.from("trailingbytes")))
            Deferred.doneUnsafe(responseReady, Effect.succeed(response));
        });
        client.once("end", () =>
          Deferred.doneUnsafe(responseReady, Effect.succeed(Buffer.concat(output))),
        );
        client.write(
          "GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
        const gateway = yield* makeHttpGateway({
          listener,
          routes: [{ capability: "rest", match: (request) => request.path === "/socket" }],
          activate: () =>
            Effect.succeed({
              capability: "rest",
              endpoint: { host: "127.0.0.1", port: backendPort },
            }),
        });
        yield* Deferred.await(handshakeReady);
        client.end();
        const response = yield* Deferred.await(responseReady).pipe(Effect.timeout("5 seconds"));
        expect(response.toString()).toContain("trailingbytes");
        yield* gateway.close;
        yield* closeServer(backend);
      }),
    ),
  );

  it.live(
    "preserves an early WebSocket upgrade and interrupts activation when the client closes",
    () =>
      withPlatform(
        Effect.gen(function* () {
          const backend = createServer((socket) => {
            socket.on("data", (chunk) => {
              if (Buffer.from(chunk).includes(Buffer.from("\r\n\r\n")))
                socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n");
            });
          });
          const backendPort = yield* listen(backend);
          const listener = yield* bindHostListener("127.0.0.1", 0, "api");
          if (listener.binding.kind !== "http")
            return yield* Effect.die("API listener did not expose HTTP binding");
          const address = listener.binding.server.address();
          if (typeof address !== "object" || address === null)
            return yield* Effect.die("HTTP listener did not expose an address");
          const client = yield* socketAt(address.port);
          const upgradeQueued = yield* Deferred.make<void>();
          const clientClosed = yield* Deferred.make<void>();
          listener.binding.server.once("upgrade", () =>
            Deferred.doneUnsafe(upgradeQueued, Effect.void),
          );
          client.once("close", () => Deferred.doneUnsafe(clientClosed, Effect.void));
          client.write(
            "GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
          );
          yield* Deferred.await(upgradeQueued);
          const activationStarted = yield* Deferred.make<void>();
          const activationInterrupted = yield* Deferred.make<void>();
          const gateway = yield* makeHttpGateway({
            listener,
            routes: [{ capability: "rest", match: (request) => request.path === "/socket" }],
            activate: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(activationStarted, undefined);
                return yield* Effect.never.pipe(
                  Effect.ensuring(Deferred.succeed(activationInterrupted, undefined)),
                );
              }),
            resolveBackend: () =>
              Effect.succeed<BackendEndpoint>({ host: "127.0.0.1", port: backendPort }),
          });
          yield* Deferred.await(activationStarted);
          client.destroy();
          yield* Deferred.await(clientClosed);
          yield* Deferred.await(activationInterrupted).pipe(Effect.timeout("5 seconds"));
          yield* gateway.close;
          yield* closeServer(backend);
        }),
      ),
  );
});
