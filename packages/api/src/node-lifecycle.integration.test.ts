import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { createApiClient as createNodeApiClient } from "./node.ts";

async function startApiServer() {
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the API test server to have a TCP address");
  }
  return { server, sockets, url: `http://127.0.0.1:${address.port}` };
}

async function stopApiServer(server: Server, sockets: ReadonlySet<Socket>) {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

describe("Node client lifecycle", () => {
  test("disposes the Node dispatcher and rejects operations after disposal", async () => {
    const { server, sockets, url } = await startApiServer();
    let client: Awaited<ReturnType<typeof createNodeApiClient>> | undefined;

    try {
      const connected = new Promise<Socket>((resolve) => server.once("connection", resolve));
      client = await createNodeApiClient({ baseUrl: url, accessToken: "test-token" });
      await expect(client.v1.listAllProjects()).resolves.toEqual([]);

      const socket = await connected;
      expect(socket.destroyed).toBe(false);
      const closed = new Promise<void>((resolve) => {
        if (socket.destroyed) {
          resolve();
        } else {
          socket.once("close", () => resolve());
        }
      });

      await client.dispose();
      await closed;
      expect(socket.destroyed).toBe(true);
      await expect(client.v1.listAllProjects()).rejects.toThrow();
    } finally {
      if (client !== undefined) {
        await client.dispose();
      }
      await stopApiServer(server, sockets);
    }
  });

  test("cleans up when client initialization fails", async () => {
    const { server, sockets, url } = await startApiServer();

    try {
      const connected = new Promise<Socket>((resolve) => server.once("connection", resolve));
      await expect(
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
                const socket = yield* Effect.promise(() => connected);
                if (sockets.size !== 1 || socket.destroyed) {
                  return yield* Effect.die("initialization request socket was not open");
                }
                return yield* Effect.die("client initialization failed");
              }),
          },
        ),
      ).rejects.toThrow("client initialization failed");

      const socket = await connected;
      const closed = new Promise<void>((resolve) => {
        if (socket.destroyed) {
          resolve();
        } else {
          socket.once("close", () => resolve());
        }
      });
      await closed;
      expect(socket.destroyed).toBe(true);
    } finally {
      await stopApiServer(server, sockets);
    }
  });
});
