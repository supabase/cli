import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Queue, Ref } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- The integration fixture needs a real Node HTTP client.
import { Agent, createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect as tcpConnect, createServer as createTcpServer, type Socket } from "node:net";
import { makeGatewayActivity } from "./ActivityTracker.ts";
import { makeHttpGateway } from "./HttpGateway.ts";
import { makeTcpGateway } from "./TcpGateway.ts";

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const route = {
  capability: "rest" as const,
  match: (request: { path: string }) => request.path === "/data",
};

const tcpRoute = {
  capability: "rest" as const,
  match: () => true,
};

const activityFixture = Effect.gen(function* () {
  const events = yield* Queue.unbounded<string>();
  const active = yield* Ref.make(0);
  const activity = yield* makeGatewayActivity({
    begin: (capability) =>
      Ref.update(active, (value) => value + 1).pipe(
        Effect.andThen(Queue.offer(events, `begin:${capability}`)),
      ),
    end: (capability) =>
      Ref.update(active, (value) => value - 1).pipe(
        Effect.andThen(Queue.offer(events, `end:${capability}`)),
      ),
  });
  return { active, activity, events };
});

const nextEvent = (events: Queue.Queue<string>) => Queue.take(events);

describe("gateway traffic activity", () => {
  it.live("tracks HTTP requests through streamed response completion", () =>
    run(
      Effect.gen(function* () {
        const { activity, active, events } = yield* activityFixture;
        let finishResponse: (() => void) | undefined;
        const backend = createHttpServer((_request, response) => {
          response.write("part");
          finishResponse = () => response.end("done");
        });
        yield* Effect.callback<void, Error>((resume) => {
          backend.listen(0, "127.0.0.1", () => resume(Effect.void));
          backend.once("error", (error) => resume(Effect.fail(error)));
          return Effect.sync(() => backend.close());
        });
        yield* Effect.addFinalizer(() =>
          Effect.callback<void>((resume) => {
            backend.close(() => resume(Effect.void));
          }),
        );
        const address = backend.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("backend unavailable");
        const gateway = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [route],
          activity,
          activate: () =>
            Effect.succeed({
              capability: "rest" as const,
              endpoint: { host: "127.0.0.1", port: address.port },
            }),
        });
        const response = yield* Effect.callback<
          { first: string; done: Effect.Effect<void, Error> },
          Error
        >((resume) => {
          const request = httpRequest(
            { host: "127.0.0.1", port: gateway.port, path: "/data" },
            (incoming) => {
              incoming.once("data", (chunk) =>
                resume(
                  Effect.succeed({
                    first: String(chunk),
                    done: Effect.callback<void, Error>((done) => {
                      incoming.once("end", () => done(Effect.void));
                      return Effect.sync(() => incoming.destroy());
                    }),
                  }),
                ),
              );
            },
          );
          request.once("error", (error) => resume(Effect.fail(error)));
          request.end();
          return Effect.sync(() => request.destroy());
        });
        expect(yield* nextEvent(events)).toBe("begin:rest");
        expect(yield* Ref.get(active)).toBe(1);
        expect(response.first).toBe("part");
        finishResponse?.();
        yield* response.done;
        expect(yield* nextEvent(events)).toBe("end:rest");
        expect(yield* Ref.get(active)).toBe(0);
        yield* gateway.close;
        yield* Effect.callback<void>((resume) => {
          backend.close(() => resume(Effect.void));
        });
      }),
    ),
  );

  it.live("does not track OPTIONS or local health responses", () =>
    run(
      Effect.gen(function* () {
        const { activity, active, events } = yield* activityFixture;
        const gateway = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          healthPaths: ["/health"],
          routes: [route],
          activity,
          activate: () => Effect.die("should not activate"),
        });
        const request = (method: string, path: string) =>
          Effect.callback<number, Error>((resume) => {
            const client = httpRequest(
              { host: "127.0.0.1", port: gateway.port, path, method },
              (response) => {
                response.resume();
                response.once("end", () => resume(Effect.succeed(response.statusCode ?? 0)));
              },
            );
            client.once("error", (error) => resume(Effect.fail(error)));
            client.end();
            return Effect.sync(() => client.destroy());
          });
        expect(yield* request("OPTIONS", "/data")).toBe(204);
        expect(yield* request("GET", "/health")).toBe(200);
        expect(Option.isNone(yield* Queue.poll(events))).toBe(true);
        expect(yield* Ref.get(active)).toBe(0);
        yield* gateway.close;
      }),
    ),
  );

  it.live("holds silent TCP activity until the client connection closes", () =>
    run(
      Effect.gen(function* () {
        const { activity, active, events } = yield* activityFixture;
        const backend = createTcpServer(() => undefined);
        yield* Effect.callback<void, Error>((resume) => {
          backend.listen(0, "127.0.0.1", () => resume(Effect.void));
          backend.once("error", (error) => resume(Effect.fail(error)));
          return Effect.sync(() => backend.close());
        });
        yield* Effect.addFinalizer(() =>
          Effect.callback<void>((resume) => {
            backend.close(() => resume(Effect.void));
          }),
        );
        const address = backend.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("backend unavailable");
        const gateway = yield* makeTcpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [tcpRoute],
          activity,
          activate: () =>
            Effect.succeed({
              capability: "rest" as const,
              endpoint: { host: "127.0.0.1", port: address.port },
            }),
        });
        const client = yield* Effect.callback<Socket, Error>((resume) => {
          const socket = tcpConnect(gateway.port, "127.0.0.1", () =>
            resume(Effect.succeed(socket)),
          );
          socket.once("error", (error) => resume(Effect.fail(error)));
          return Effect.sync(() => socket.destroy());
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => client.destroy()));
        expect(yield* nextEvent(events)).toBe("begin:rest");
        expect(yield* Ref.get(active)).toBe(1);
        expect(Option.isNone(yield* Queue.poll(events))).toBe(true);
        client.destroy();
        expect(yield* nextEvent(events)).toBe("end:rest");
        expect(yield* Ref.get(active)).toBe(0);
        yield* gateway.close;
        yield* Effect.callback<void>((resume) => {
          backend.close(() => resume(Effect.void));
        });
      }),
    ),
  );

  it.live("holds a silent WebSocket upgrade until its socket closes", () =>
    run(
      Effect.gen(function* () {
        const { activity, active, events } = yield* activityFixture;
        const backend = createHttpServer();
        backend.on("upgrade", (_request, socket) =>
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
          ),
        );
        yield* Effect.callback<void, Error>((resume) => {
          backend.listen(0, "127.0.0.1", () => resume(Effect.void));
          backend.once("error", (error) => resume(Effect.fail(error)));
          return Effect.sync(() => backend.close());
        });
        yield* Effect.addFinalizer(() =>
          Effect.callback<void>((resume) => {
            backend.close(() => resume(Effect.void));
          }),
        );
        const address = backend.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("backend unavailable");
        const gateway = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [{ capability: "rest" as const, match: () => true }],
          activity,
          activate: () =>
            Effect.succeed({
              capability: "rest" as const,
              endpoint: { host: "127.0.0.1", port: address.port },
            }),
        });
        const client = yield* Effect.callback<Socket, Error>((resume) => {
          const socket = tcpConnect(gateway.port, "127.0.0.1", () => {
            socket.write(
              "GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
            );
            resume(Effect.succeed(socket));
          });
          socket.once("error", (error) => resume(Effect.fail(error)));
          return Effect.sync(() => socket.destroy());
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => client.destroy()));
        expect(yield* nextEvent(events)).toBe("begin:rest");
        expect(yield* Ref.get(active)).toBe(1);
        expect(Option.isNone(yield* Queue.poll(events))).toBe(true);
        client.destroy();
        expect(yield* nextEvent(events)).toBe("end:rest");
        expect(yield* Ref.get(active)).toBe(0);
        yield* gateway.close;
        yield* Effect.callback<void>((resume) => {
          backend.close(() => resume(Effect.void));
        });
      }),
    ),
  );

  it.live("releases activity when an HTTP client aborts and ignores keep-alive sockets", () =>
    run(
      Effect.gen(function* () {
        const { activity, active, events } = yield* activityFixture;
        let requestCount = 0;
        let responseToFinish: (() => void) | undefined;
        let requestObserved = false;
        let requestObservedResume: (() => void) | undefined;
        const backend = createHttpServer((_request, response) => {
          requestCount += 1;
          requestObserved = true;
          requestObservedResume?.();
          if (requestCount > 1) response.end("done");
          else responseToFinish = () => response.end("done");
        });
        yield* Effect.callback<void, Error>((resume) => {
          backend.listen(0, "127.0.0.1", () => resume(Effect.void));
          backend.once("error", (error) => resume(Effect.fail(error)));
          return Effect.sync(() => backend.close());
        });
        yield* Effect.addFinalizer(() =>
          Effect.callback<void>((resume) => {
            backend.close(() => resume(Effect.void));
          }),
        );
        const address = backend.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("backend unavailable");
        const gateway = yield* makeHttpGateway({
          address: "127.0.0.1",
          port: 0,
          routes: [route],
          activity,
          activate: () =>
            Effect.succeed({
              capability: "rest" as const,
              endpoint: { host: "127.0.0.1", port: address.port },
            }),
        });
        const client = httpRequest({ host: "127.0.0.1", port: gateway.port, path: "/data" });
        client.on("error", () => undefined);
        yield* Effect.addFinalizer(() => Effect.sync(() => client.destroy()));
        client.end();
        expect(yield* nextEvent(events)).toBe("begin:rest");
        if (!requestObserved)
          yield* Effect.callback<void>((resume) => {
            requestObservedResume = () => resume(Effect.void);
            return Effect.sync(() => (requestObservedResume = undefined));
          });
        client.destroy();
        expect(yield* nextEvent(events)).toBe("end:rest");
        expect(yield* Ref.get(active)).toBe(0);
        responseToFinish?.();
        const agent = new Agent({ keepAlive: true });
        yield* Effect.addFinalizer(() => Effect.sync(() => agent.destroy()));
        yield* Effect.callback<void, Error>((resume) => {
          const keepAliveRequest = httpRequest(
            { host: "127.0.0.1", port: gateway.port, path: "/data", agent },
            (response) => {
              response.resume();
              response.once("end", () => resume(Effect.void));
            },
          );
          keepAliveRequest.on("error", (error) => resume(Effect.fail(error)));
          keepAliveRequest.end();
          return Effect.sync(() => keepAliveRequest.destroy());
        });
        expect(yield* nextEvent(events)).toBe("begin:rest");
        expect(yield* nextEvent(events)).toBe("end:rest");
        expect(yield* Ref.get(active)).toBe(0);
        agent.destroy();
        yield* gateway.close;
        yield* Effect.callback<void>((resume) => {
          backend.close(() => resume(Effect.void));
        });
      }),
    ),
  );
});
