// oxlint-disable effecttsgo/async-function, effecttsgo/global-timers, effecttsgo/new-promise, effecttsgo/node-builtin-import, effecttsgo/run-effect-inside-effect -- Node transport tests coordinate native HTTP agents, sockets, and readiness callbacks in the integration harness.
import { Deferred, Cause, Effect, Exit, Predicate } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { Agent, createServer, get, type Server } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, test } from "vitest";
import {
  ControlProtocolError,
  ControlStopConflictError,
  ControlTransport,
  ControlTransportError,
  makeControlClient,
  type ControlEndpoint,
} from "./managed/control.ts";
import { controlTransportLayer } from "./platform-node.ts";

const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;

const listen = (server: Server): Promise<ControlEndpoint> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected TCP address"));
        return;
      }
      resolve({
        hostname: "127.0.0.1",
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
      });
    });
  });

const close = (server: Server, sockets: ReadonlySet<Socket>): Promise<void> =>
  new Promise((resolve, reject) => {
    for (const socket of sockets) socket.destroy();
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

const withTimeout = async <A>(promise: Promise<A>, timeoutMs = 5_000): Promise<A> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<A>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const runRead = (endpoint: ControlEndpoint) =>
  Effect.runPromise(
    Effect.flatMap(ControlTransport, (transport) => transport.read(endpoint)).pipe(
      Effect.provide(controlTransportLayer),
      Effect.exit,
    ),
  );

const runStop = (endpoint: ControlEndpoint) =>
  Effect.runPromise(
    Effect.flatMap(ControlTransport, (transport) =>
      transport.requestStop(endpoint, {
        ownershipId: "0".repeat(64),
        ownerSessionId: "session",
        intent: "explicit",
      }),
    ).pipe(Effect.provide(controlTransportLayer), Effect.exit),
  );

const expectTypedFailure = <E extends object>(
  exit: Exit.Exit<unknown, E>,
  error: new (...args: any[]) => E,
) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(error);
};

describe("Node control transport", () => {
  test("closes an idle keep-alive RPC socket immediately", async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const closeCompleted = Deferred.makeUnsafe<void>();
    let closeFiber: Promise<unknown> | undefined;
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const transport = yield* ControlTransport;
            const listener = yield* transport.bind(
              { hostname: "127.0.0.1", port: 0, url: "http://127.0.0.1:0" },
              () => ({
                controlProtocol: "supabase-stack-control" as const,
                controlProtocolVersion: 1 as const,
                ownershipId: "0".repeat(64),
                ownerSessionId: "keep-alive-session",
                kind: "supervisor" as const,
                state: "running" as const,
                ready: true,
                daemonCliVersion: "test",
              }),
              () => "accepted",
              { app: Effect.succeed(HttpServerResponse.text("ok")) },
            );
            const address = listener.server.address;
            if (!Predicate.isTagged(address, "TcpAddress")) throw new Error("expected TCP address");
            yield* Effect.tryPromise(
              () =>
                new Promise<void>((resolve, reject) => {
                  const request = get(
                    {
                      host: "127.0.0.1",
                      port: address.port,
                      path: "/rpc",
                      agent,
                    },
                    (response: import("node:http").IncomingMessage) => {
                      response.resume();
                      response.once("end", resolve);
                    },
                  );
                  request.once("error", reject);
                }),
            );
            const close = listener.close.pipe(
              Effect.andThen(Deferred.succeed(closeCompleted, undefined)),
            );
            closeFiber = Effect.runPromise(close);
            const closed = yield* Deferred.await(closeCompleted).pipe(
              Effect.timeout("1 second"),
              Effect.exit,
            );
            return closed;
          }).pipe(Effect.provide(controlTransportLayer)),
        ),
      );
      expect(Exit.isSuccess(result)).toBe(true);
    } finally {
      agent.destroy();
      await closeFiber;
    }
  });

  test("classifies a fenced stop conflict distinctly from transport failure", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((_request, response) => {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "conflict" }));
    });
    server.on("connection", (socket) => sockets.add(socket));
    try {
      const endpoint = await listen(server);
      const exit = await runStop(endpoint);
      expectTypedFailure(exit, ControlStopConflictError);
    } finally {
      await close(server, sockets);
    }
  });

  test("stable client completes the captured stop after a replacement conflict", async () => {
    const ownershipId = "0".repeat(64);
    const ownerSessionId = "captured-session";
    const stopBodies: Array<string> = [];
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      if (request.url === "/owner") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            controlProtocol: "supabase-stack-control",
            controlProtocolVersion: 1,
            ownershipId,
            ownerSessionId: "replacement-session",
            kind: "supervisor",
            state: "running",
            ready: true,
            daemonCliVersion: "test",
          }),
        );
        return;
      }
      request.setEncoding("utf8");
      let body = "";
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.once("end", () => {
        stopBodies.push(body);
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "conflict" }));
      });
    });
    server.on("connection", (socket) => sockets.add(socket));
    try {
      const endpoint = await listen(server);
      const exit = await Effect.runPromise(
        Effect.flatMap(ControlTransport, (transport) =>
          makeControlClient(transport).stopSession(endpoint, ownershipId, ownerSessionId),
        ).pipe(Effect.provide(controlTransportLayer), Effect.exit),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(stopBodies).toEqual([
        JSON.stringify({ ownershipId, ownerSessionId, intent: "explicit" }),
      ]);
    } finally {
      await close(server, sockets);
    }
  });

  test("maps post-header resets from owner and stop probes to typed failures", async () => {
    let requestCount = 0;
    let resolveRequest!: () => void;
    let requestReady = Promise.resolve();
    const sockets = new Set<Socket>();
    const server = createServer((_request, response) => {
      sockets.add(response.socket!);
      response.socket!.once("close", () => sockets.delete(response.socket!));
      resolveRequest();
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.write(requestCount++ === 0 ? '{"protocolVersion":' : "{", () => response.destroy());
    });
    server.on("connection", (socket) => sockets.add(socket));
    try {
      const endpoint = await listen(server);

      const prepareRequest = () => {
        requestReady = new Promise<void>((resolve) => {
          resolveRequest = resolve;
        });
      };

      prepareRequest();
      const readExitPromise = runRead(endpoint);
      await requestReady;
      const readExit = await withTimeout(readExitPromise);
      expectTypedFailure(readExit, ControlTransportError);

      prepareRequest();
      const stopExitPromise = runStop(endpoint);
      await requestReady;
      const stopExit = await withTimeout(stopExitPromise);
      expectTypedFailure(stopExit, ControlTransportError);
    } finally {
      await close(server, sockets);
    }
  });

  test("classifies control timeouts as transport instead of absence", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((_request, response) => {
      sockets.add(response.socket!);
      response.socket!.once("close", () => sockets.delete(response.socket!));
      // Keep the status request open until the client-side deadline expires.
    });
    server.on("connection", (socket) => sockets.add(socket));
    try {
      const endpoint = await listen(server);
      // This is only a deadlock guard; the assertion is about the typed
      // failure, not wall-clock scheduling on a loaded runner.
      const readExit = await withTimeout(runRead(endpoint), 10_000);
      expectTypedFailure(readExit, ControlTransportError);
      if (Exit.isFailure(readExit)) {
        expect(Cause.squash(readExit.cause)).toMatchObject({ reason: "transport" });
      }

      const stopExit = await withTimeout(runStop(endpoint), 10_000);
      expectTypedFailure(stopExit, ControlTransportError);
      if (Exit.isFailure(stopExit)) {
        expect(Cause.squash(stopExit.cause)).toMatchObject({ reason: "transport" });
      }
    } finally {
      await close(server, sockets);
    }
  });

  test("bounds an oversized owner status and closes the exact connection", async () => {
    let resolveRequest!: () => void;
    const requestReady = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    let resolveClosed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const sockets = new Set<Socket>();
    const server = createServer((_request, response) => {
      const socket = response.socket;
      if (socket === null) throw new Error("Expected request socket");
      sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
        resolveClosed();
      });
      resolveRequest();
      response.writeHead(200, { "content-type": "application/json" });
      response.write("x".repeat(MAX_CONTROL_RESPONSE_BYTES + 1));
    });
    server.on("connection", (socket) => sockets.add(socket));
    try {
      const endpoint = await listen(server);
      const exitPromise = runRead(endpoint);
      await requestReady;
      const exit = await withTimeout(exitPromise);
      expectTypedFailure(exit, ControlProtocolError);
      await withTimeout(connectionClosed);
    } finally {
      await close(server, sockets);
    }
  });
});
