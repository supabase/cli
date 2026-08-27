// oxlint-disable effecttsgo/async-function, effecttsgo/global-timers, effecttsgo/new-promise, effecttsgo/node-builtin-import -- Transport tests coordinate native HTTP sockets and readiness callbacks through Vitest's Promise boundary.
import { Effect, Fiber, ManagedRuntime } from "effect";
import type { Socket } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { HttpTransportClient, httpTransportClientLayer } from "./HttpTransportClient.ts";
import type { ControlEndpoint } from "./managed/control.ts";

const endpointFor = (server: Server): ControlEndpoint => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  return {
    hostname: "127.0.0.1",
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
  };
};

const listen = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

const withTimeout = async <A>(promise: Promise<A>, timeoutMs: number): Promise<A> => {
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

describe("HttpTransportClient", () => {
  let server: Server | undefined;
  let activeSocket: Socket | undefined;

  afterEach(async () => {
    activeSocket?.destroy();
    if (server !== undefined) await close(server);
    activeSocket = undefined;
    server = undefined;
  });

  test("closes an unanswered request when its fiber is interrupted", async () => {
    let requestArrived!: () => void;
    const requestReady = new Promise<void>((resolve) => {
      requestArrived = resolve;
    });
    let closed = false;
    let connectionClosed!: () => void;
    const connectionClosedPromise = new Promise<void>((resolve) => {
      connectionClosed = () => {
        closed = true;
        resolve();
      };
    });

    server = createServer((_request, response) => {
      const socket = response.socket;
      if (socket === null) throw new Error("Expected request socket");
      activeSocket = socket;
      requestArrived();
      socket.once("close", connectionClosed);
    });
    await listen(server);

    const runtime = ManagedRuntime.make(httpTransportClientLayer);
    try {
      const fiber = runtime.runFork(
        Effect.gen(function* () {
          const client = yield* HttpTransportClient;
          yield* client.request(endpointFor(server!), "/never");
        }),
      );
      await requestReady;
      await runtime.runPromise(Fiber.interrupt(fiber));
      await withTimeout(connectionClosedPromise, 5_000);
      expect(closed).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });
});
