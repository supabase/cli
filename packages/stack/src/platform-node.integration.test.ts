import { Cause, Effect, Exit } from "effect";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, test } from "vitest";
import {
  ControlProtocolError,
  ControlTransport,
  ControlTransportError,
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
