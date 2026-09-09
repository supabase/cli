import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option, Predicate, Queue } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createServer, request as httpRequest, type Server as HttpServer } from "node:http";
import { connect as connectNet, type Server as NetServer, type Socket } from "node:net";
import { PortUnavailableError } from "../public/Errors.ts";
import { bindHostListener, bindHostListenerWithOptions, checkHostPort } from "./HostListener.ts";

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe("host listener binding", () => {
  it.live("allocates independent TCP resources for each evaluation", () =>
    run(
      Effect.gen(function* () {
        const effect = bindHostListener("127.0.0.1", 0, "database");
        const [first, second] = yield* Effect.all([effect, effect], { concurrency: 2 });
        expect(first.port).toBeGreaterThan(0);
        expect(second.port).toBeGreaterThan(0);
        expect(first.port).not.toBe(second.port);
        yield* first.close;
        expect(first.binding.server.listening).toBe(false);
        const socket = yield* Effect.acquireRelease(
          Effect.callback<Socket, Error>((resume) => {
            const connection = connectNet(second.port, "127.0.0.1");
            connection.once("connect", () => resume(Effect.succeed(connection)));
            connection.once("error", (error) => resume(Effect.fail(error)));
            return Effect.sync(() => connection.destroy());
          }),
          (connection) => Effect.sync(() => connection.destroy()),
        );
        expect(socket.destroyed).toBe(false);
      }),
    ),
  );

  it.live("evaluates concurrent port checks with independent temporary servers", () =>
    run(
      Effect.gen(function* () {
        const effect = checkHostPort("127.0.0.1", 0, "database");
        const ports = yield* Effect.all([effect, effect], { concurrency: 2 });
        expect(ports).toEqual([undefined, undefined]);
      }),
    ),
  );

  it.live("binds an IPv6 wildcard listener with dual-stack IPv4 access", () =>
    run(
      Effect.gen(function* () {
        const listener = yield* bindHostListener("::", 0, "api");
        expect(listener.port).toBeGreaterThan(0);
        if (listener.binding.kind !== "http" || listener.binding.pendingEvents === undefined)
          return yield* Effect.die("IPv6 API listener did not expose HTTP events");
        const request = yield* Effect.forkChild(
          Effect.callback<import("node:http").IncomingMessage, Error>((resume) => {
            const request = httpRequest(
              { host: "127.0.0.1", port: listener.port, path: "/" },
              (response) => resume(Effect.succeed(response)),
            );
            request.once("error", (error) => resume(Effect.fail(error)));
            request.end();
            return Effect.sync(() => request.destroy());
          }),
          { startImmediately: true },
        );
        const event = yield* Queue.take(listener.binding.pendingEvents.queue);
        if (!Predicate.isTagged(event, "request"))
          return yield* Effect.die("IPv4 request was not captured");
        event.response.end("ok");
        const response = yield* Fiber.join(request);
        response.resume();
      }),
    ),
  );

  it.live("binds HTTP and TCP listeners for direct gateway adoption", () =>
    run(
      Effect.gen(function* () {
        const http = yield* bindHostListener("127.0.0.1", 0, "api");
        const tcp = yield* bindHostListener("127.0.0.1", 0, "database");
        expect(http.binding.kind).toBe("http");
        expect(tcp.binding.kind).toBe("tcp");
        expect(http.binding.server.listening).toBe(true);
        expect(tcp.binding.server.listening).toBe(true);
        yield* http.close;
        yield* http.close;
        yield* tcp.close;
        expect(http.binding.server.listening).toBe(false);
        expect(tcp.binding.server.listening).toBe(false);
      }),
    ),
  );

  it.live("reports an occupied exact listener as a typed unavailable error", () =>
    run(
      Effect.gen(function* () {
        const held = yield* bindHostListener("127.0.0.1", 0, "api");
        const address = held.binding.server.address();
        if (typeof address !== "object" || address === null)
          return yield* Effect.die("bound listener did not expose an address");
        let failedServer: HttpServer | undefined;
        const failed = yield* bindHostListenerWithOptions("127.0.0.1", address.port, "api", {
          createHttpServer: () => {
            const created = createServer();
            failedServer = created;
            return created;
          },
        }).pipe(Effect.exit);
        const error = errorOf(failed);
        expect(error).toBeInstanceOf(PortUnavailableError);
        expect(error).toMatchObject({ cause: { code: "EADDRINUSE" } });
        expect(failedServer?.listening).toBe(false);
      }),
    ),
  );

  it.live("cancels a listener whose bind callback has not fired", () =>
    run(
      Effect.gen(function* () {
        let server: HttpServer | undefined;
        // The real server factory is intentionally used through a deferred listen seam below;
        // this keeps the cancellation test deterministic without racing a kernel bind.
        const effect = bindHostListenerWithOptions("127.0.0.1", 0, "api", {
          createHttpServer: () => {
            const created = createServer();
            server = created;
            return created;
          },
          listen: () => undefined,
        });
        const fiber = yield* Effect.forkChild(effect);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        expect(server?.listening).toBe(false);
      }),
    ),
  );

  it.live("closes connections accepted before gateway adoption", () =>
    run(
      Effect.gen(function* () {
        const http = yield* bindHostListener("127.0.0.1", 0, "api");
        const tcp = yield* bindHostListener("127.0.0.1", 0, "database");
        const connect = (server: HttpServer | NetServer) =>
          Effect.gen(function* () {
            const address = server.address();
            if (typeof address !== "object" || address === null) {
              return yield* Effect.die("listener did not expose an address");
            }
            const accepted = yield* Effect.forkChild(
              Effect.callback<Socket, Error>((resume) => {
                const onConnection = (socket: Socket) => resume(Effect.succeed(socket));
                server.once("connection", onConnection);
                return Effect.sync(() => server.off("connection", onConnection));
              }),
              { startImmediately: true },
            );
            yield* Effect.acquireRelease(
              Effect.callback<Socket, Error>((resume) => {
                const socket = connectNet(address.port, "127.0.0.1");
                socket.once("connect", () => resume(Effect.succeed(socket)));
                socket.once("error", (error) => resume(Effect.fail(error)));
                return Effect.sync(() => {
                  socket.destroy();
                });
              }),
              (socket) => Effect.sync(() => socket.destroy()),
            );
            const acceptedSocket = yield* Fiber.join(accepted).pipe(Effect.timeout("5 seconds"));
            return acceptedSocket;
          });
        const httpSocket = yield* connect(http.binding.server);
        const tcpSocket = yield* connect(tcp.binding.server);
        yield* http.close;
        yield* tcp.close;
        expect(httpSocket.destroyed).toBe(true);
        expect(tcpSocket.destroyed).toBe(true);
      }),
    ),
  );
});
