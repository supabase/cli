import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Predicate,
  Ref,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- NodeHttpServer.make requires a native server factory.
import * as Http from "node:http";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- raw client and backend fixtures for connection failures.
import { createServer, Socket, type Server } from "node:net";
import { captureLogs } from "../tests/logs.ts";
import { bindTcp, serveTcp, ProxyError } from "./Proxy.ts";

const captureErrors = captureLogs(["Error"]);

it.live(
  "waits for target readiness and forwards a streamed response through its retained TCP listener",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* NodeHttpServer.make(() => Http.createServer(), {
          host: "127.0.0.1",
          port: 0,
        });
        yield* backend.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            return HttpServerResponse.stream(request.stream, {
              contentType: "application/octet-stream",
            });
          }),
        );
        const listener = yield* bindTcp("127.0.0.1", 0);
        if (
          !Predicate.isTagged(backend.address, "TcpAddress") ||
          !Predicate.isTagged(listener.address, "TcpAddress")
        )
          return yield* Effect.die("Expected TCP listeners");
        const address = { host: "127.0.0.1", port: backend.address.port };
        const acquired = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const target = Effect.acquireRelease(Deferred.succeed(acquired, undefined), () =>
          Deferred.succeed(released, undefined),
        ).pipe(Effect.andThen(Deferred.await(ready)), Effect.as(address));
        yield* serveTcp(listener, target, "backend").pipe(Effect.forkScoped);
        const body = new Uint8Array(2 * 1024 * 1024).fill(71);
        const client = yield* HttpClient.HttpClient;
        const request = client
          .execute(
            HttpClientRequest.post(`http://127.0.0.1:${listener.address.port}/echo`).pipe(
              HttpClientRequest.bodyUint8Array(body),
              HttpClientRequest.setHeader("connection", "close"),
            ),
          )
          .pipe(Effect.flatMap((response) => response.arrayBuffer));
        const response = yield* request.pipe(Effect.forkScoped);
        yield* Deferred.await(acquired);
        expect(yield* Deferred.isDone(released)).toBe(false);
        yield* Deferred.succeed(ready, undefined);
        const bytes = Buffer.from(yield* Fiber.join(response));
        // An element-wise toEqual over 2 MiB blocks the event loop for seconds.
        expect(bytes.byteLength).toBe(body.byteLength);
        expect(bytes.equals(body)).toBe(true);
        yield* Deferred.await(released);
      }),
    ).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
);

const connectAndAwaitClose = (port: number) =>
  Effect.callback<void, never>((resume) => {
    const socket = new Socket();
    socket.once("close", () => resume(Effect.void));
    socket.once("error", () => undefined);
    socket.connect(port, "127.0.0.1");
    return Effect.sync(() => socket.destroy());
  }).pipe(Effect.timeout("5 seconds"));

it.live("logs one error naming the endpoint when its target fails to wake", () => {
  const logs: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const listener = yield* bindTcp("127.0.0.1", 0);
      if (!Predicate.isTagged(listener.address, "TcpAddress"))
        return yield* Effect.die("Expected TCP listener");
      const port = listener.address.port;
      const target = Effect.fail(new ProxyError({ message: "wake failed" }));
      yield* serveTcp(listener, target, "db:sql").pipe(Effect.forkScoped);
      yield* connectAndAwaitClose(port);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("Endpoint db:sql failed");
    }),
  ).pipe(Effect.provide(captureErrors(logs)));
});

interface ResetBackend {
  readonly port: number;
  readonly server: Server;
}

// Resets only after receiving data, so the reset always lands after a completed handshake.
const listenResetBackend = () =>
  Effect.acquireRelease(
    Effect.callback<ResetBackend, never>((resume) => {
      const server = createServer((socket) => {
        socket.once("data", () => socket.resetAndDestroy());
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(
          Effect.succeed({
            port: typeof address === "object" && address !== null ? address.port : 0,
            server,
          }),
        );
      });
      return Effect.void;
    }),
    ({ server }) =>
      Effect.callback<void, never>((resume) => {
        server.close(() => resume(Effect.void));
        return Effect.void;
      }),
  );

it.live("does not log an error when a backend copy resets after a successful connect", () => {
  const logs: Array<string> = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const listener = yield* bindTcp("127.0.0.1", 0);
      if (!Predicate.isTagged(listener.address, "TcpAddress"))
        return yield* Effect.die("Expected TCP listener");
      const port = listener.address.port;
      const backend = yield* listenResetBackend();
      const target = Effect.succeed({ host: "127.0.0.1", port: backend.port });
      yield* serveTcp(listener, target, "db:sql").pipe(Effect.forkScoped);
      yield* Effect.callback<void, never>((resume) => {
        const socket = new Socket();
        socket.once("close", () => resume(Effect.void));
        socket.once("error", () => undefined);
        socket.once("connect", () => socket.write("ping"));
        socket.connect(port, "127.0.0.1");
        return Effect.sync(() => socket.destroy());
      }).pipe(Effect.timeout("5 seconds"));
      expect(logs).toHaveLength(0);
    }),
  ).pipe(Effect.provide(captureErrors(logs)));
});

/** Starts a raw TCP echo backend and returns its address, retained until the scope closes. */
const echoBackend = () =>
  Effect.acquireRelease(
    Effect.callback<
      { readonly server: Server; readonly host: string; readonly port: number },
      never
    >((resume) => {
      const server = createServer((socket) => socket.pipe(socket));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(
          Effect.succeed({
            server,
            host: "127.0.0.1",
            port: typeof address === "object" && address !== null ? address.port : 0,
          }),
        );
      });
      return Effect.void;
    }),
    ({ server }) =>
      Effect.callback<void, never>((resume) => {
        server.close(() => resume(Effect.void));
        return Effect.void;
      }),
  );

const connectAndWrite = (port: number, message: string) =>
  Effect.acquireRelease(
    Effect.callback<Socket, never>((resume) => {
      const socket = new Socket();
      socket.once("connect", () => resume(Effect.succeed(socket)));
      socket.connect(port, "127.0.0.1");
      return Effect.void;
    }),
    (socket) => Effect.sync(() => socket.destroy()),
  ).pipe(Effect.tap((socket) => Effect.sync(() => socket.write(message))));

const readOnceTcp = (socket: Socket) =>
  Effect.callback<string, never>((resume) => {
    const onData = (chunk: Buffer) => resume(Effect.succeed(chunk.toString()));
    socket.once("data", onData);
    return Effect.sync(() => socket.off("data", onData));
  }).pipe(Effect.timeout("5 seconds"));

it.live(
  "releases the scoped target and keeps serving the next connection after a client resets while readiness is pending",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const listener = yield* bindTcp("127.0.0.1", 0);
        if (!Predicate.isTagged(listener.address, "TcpAddress"))
          return yield* Effect.die("Expected TCP listener");
        const port = listener.address.port;
        const backend = yield* echoBackend();
        const acquired = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const connections = yield* Ref.make(0);
        // Only the first connection's target acquisition is held behind the gate; a later one
        // (the "listener still serves" check below) resolves immediately against the real backend.
        const target = Ref.updateAndGet(connections, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 1
              ? Effect.acquireRelease(Deferred.succeed(acquired, undefined), () =>
                  Deferred.succeed(released, undefined),
                ).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.as({ host: backend.host, port: backend.port }),
                )
              : Effect.succeed({ host: backend.host, port: backend.port }),
          ),
        );
        yield* serveTcp(listener, target, "cold-wake").pipe(Effect.forkScoped);

        const client = yield* Effect.acquireRelease(
          Effect.callback<Socket, never>((resume) => {
            const socket = new Socket();
            socket.once("connect", () => resume(Effect.succeed(socket)));
            socket.connect(port, "127.0.0.1");
            return Effect.void;
          }),
          (socket) => Effect.sync(() => socket.destroy()),
        );
        yield* Deferred.await(acquired);
        // Readiness is still pending behind `gate`; an unhandled reset here would otherwise crash
        // the owning process before the fix.
        yield* Effect.sync(() => client.resetAndDestroy());
        yield* Deferred.await(released);

        // The listener (and the process running it) survived the reset and still serves a fresh
        // connection normally.
        const probe = yield* connectAndWrite(port, "ping");
        expect(yield* readOnceTcp(probe)).toBe("ping");
      }),
    ),
);

it.live(
  "refuses a new connection after stopAccepting while an established connection keeps relaying data through the scoped target until it closes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* echoBackend();
        const listener = yield* bindTcp("127.0.0.1", 0);
        if (!Predicate.isTagged(listener.address, "TcpAddress"))
          return yield* Effect.die("Expected TCP listener");
        const target = Effect.succeed({ host: backend.host, port: backend.port });
        yield* serveTcp(listener, target, "echo").pipe(Effect.forkScoped);
        const port = listener.address.port;

        const client = yield* connectAndWrite(port, "ping");
        expect(yield* readOnceTcp(client)).toBe("ping");
        expect(yield* SubscriptionRef.get(listener.outstandingConnections)).toBe(1);

        yield* listener.stopAccepting;

        const refused = yield* Effect.callback<boolean, never>((resume) => {
          const probe = new Socket();
          let responded = false;
          let settled = false;
          // A refused connection surfaces as a reset, a generic error, or a plain close; all three
          // are the allowed refusal outcomes here, so long as no response ever arrived.
          const settle = () => {
            if (settled) return;
            settled = true;
            resume(Effect.succeed(!responded));
          };
          probe.once("data", () => {
            responded = true;
          });
          probe.once("error", settle);
          probe.once("close", settle);
          probe.connect(port, "127.0.0.1", () => probe.write("probe"));
          return Effect.sync(() => probe.destroy());
        }).pipe(Effect.timeout("5 seconds"));
        expect(refused).toBe(true);

        client.write("pong");
        expect(yield* readOnceTcp(client)).toBe("pong");

        const reachedZero = yield* Stream.runHead(
          Stream.filter(
            SubscriptionRef.changes(listener.outstandingConnections),
            (count) => count === 0,
          ),
        ).pipe(Effect.forkScoped);
        yield* Effect.sync(() => client.end());
        yield* Fiber.join(reachedZero);
      }),
    ),
);

it.live(
  "destroys every established connection immediately when cutAll runs on the production listener",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = yield* echoBackend();
        const listener = yield* bindTcp("127.0.0.1", 0);
        if (!Predicate.isTagged(listener.address, "TcpAddress"))
          return yield* Effect.die("Expected TCP listener");
        const target = Effect.succeed({ host: backend.host, port: backend.port });
        yield* serveTcp(listener, target, "echo").pipe(Effect.forkScoped);
        const port = listener.address.port;

        const client = yield* connectAndWrite(port, "ping");
        expect(yield* readOnceTcp(client)).toBe("ping");
        expect(yield* SubscriptionRef.get(listener.outstandingConnections)).toBe(1);

        const closed = yield* Effect.callback<void, never>((resume) => {
          const onClose = () => resume(Effect.void);
          client.once("close", onClose);
          if (client.destroyed) onClose();
          return Effect.sync(() => client.off("close", onClose));
        }).pipe(Effect.timeout("5 seconds"), Effect.forkScoped);
        // Subscribed before `cutAll` runs: the client's own "close" event is a separate, cross-
        // socket signal that reaches this process over the loopback connection, with no ordering
        // guarantee relative to the listener's own bookkeeping (observed to lag it on Windows), so
        // the listener's count must be awaited on its own observable, never inferred from the
        // client's.
        const reachedZero = yield* Stream.runHead(
          Stream.filter(
            SubscriptionRef.changes(listener.outstandingConnections),
            (count) => count === 0,
          ),
        ).pipe(Effect.forkScoped);
        yield* listener.cutAll;
        yield* Fiber.join(closed);
        yield* Fiber.join(reachedZero);
        expect(yield* SubscriptionRef.get(listener.outstandingConnections)).toBe(0);
      }),
    ),
);

it.live(
  "counts, cuts, and tears down a connection that arrives before run installs its handler",
  () =>
    Effect.gen(function* () {
      const listenerScope = yield* Scope.make();
      const listener = yield* bindTcp("127.0.0.1", 0).pipe(Scope.provide(listenerScope));
      if (!Predicate.isTagged(listener.address, "TcpAddress"))
        return yield* Effect.die("Expected TCP listener");
      const port = listener.address.port;

      const connect = () =>
        Effect.callback<Socket, never>((resume) => {
          const socket = new Socket();
          socket.once("connect", () => resume(Effect.succeed(socket)));
          socket.connect(port, "127.0.0.1");
          return Effect.void;
        }).pipe(Effect.timeout("5 seconds"));
      const awaitClose = (socket: Socket) =>
        Effect.callback<void, never>((resume) => {
          const onClose = () => resume(Effect.void);
          socket.once("close", onClose);
          if (socket.destroyed) onClose();
          return Effect.sync(() => socket.off("close", onClose));
        }).pipe(Effect.timeout("5 seconds"));
      // The server's own acceptance (tracked by `outstandingConnections`) is a separate event from
      // the client's own "connect"; subscribed before connecting so neither ordering is assumed.
      const awaitOutstanding = (expected: number) =>
        Stream.runHead(
          Stream.filter(
            SubscriptionRef.changes(listener.outstandingConnections),
            (count) => count === expected,
          ),
        ).pipe(Effect.timeout("5 seconds"));

      // `run` is never called on this listener: every connection below is, and stays, queued.
      const firstAccepted = yield* awaitOutstanding(1).pipe(Effect.forkScoped);
      const first = yield* connect();
      yield* Fiber.join(firstAccepted);

      const firstCut = yield* awaitOutstanding(0).pipe(Effect.forkScoped);
      yield* listener.cutAll;
      yield* awaitClose(first);
      yield* Fiber.join(firstCut);

      // Closing the listener's own scope destroys a still-queued connection and completes rather
      // than hanging on `server.close()` waiting for a socket nothing ever destroyed.
      const secondAccepted = yield* awaitOutstanding(1).pipe(Effect.forkScoped);
      const second = yield* connect();
      yield* Fiber.join(secondAccepted);
      const secondClosed = yield* awaitClose(second).pipe(Effect.forkScoped);
      yield* Scope.close(listenerScope, Exit.void).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.join(secondClosed);
    }).pipe(Effect.scoped),
);
