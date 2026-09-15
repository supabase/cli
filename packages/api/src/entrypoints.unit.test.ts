import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as effectModule from "./effect.ts";
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

describe("@supabase/api entrypoints", () => {
  test("exports the generated contracts without embedding the OpenAPI document", () => {
    expect(effectModule.operationDefinitions.v1CreateAProject.method).toBe("POST");
    expect(effectModule.openApiOperationIdMap["v1-create-a-project"]).toBe("v1CreateAProject");
    expect(effectModule.V1CreateAProjectInput).toBeDefined();
    expect("SupabaseApiClient" in effectModule).toBe(false);
    expect("makeSupabaseApiClient" in effectModule).toBe(false);
    expect("supabaseApiClientLayer" in effectModule).toBe(false);
    expect("v1ListAllProjects" in effectModule).toBe(false);
  });

  test("exports runtime-specific client builders", () => {
    expect(typeof createNodeApiClient).toBe("function");
    expect(typeof effectModule.makeApiClient).toBe("function");
    expect(effectModule.ApiConfig).toBeDefined();
    expect(effectModule.apiConfigLayer).toBeDefined();
    expect(effectModule.DEFAULT_SUPABASE_API_URL).toBe("https://api.supabase.com");
  });

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
      await expect(client.v1.listAllProjects()).rejects.toThrow("ManagedRuntime disposed");
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

  test("does not generate separate promise or standalone operation artifacts", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    expect(existsSync(join(srcDir, "generated/promise-client.ts"))).toBe(false);
    expect(existsSync(join(srcDir, "generated/effect-operations.ts"))).toBe(false);
  });

  test("ships the OpenAPI spec as a json subpath artifact", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const packageJson = JSON.parse(readFileSync(join(srcDir, "../package.json"), "utf8")) as {
      readonly exports: Record<string, string | Record<string, string>>;
    };
    const openApiDocument = JSON.parse(
      readFileSync(join(srcDir, "generated/openapi.json"), "utf8"),
    ) as { readonly openapi: string };

    expect(packageJson.exports["."]).toEqual({
      bun: "./src/bun.ts",
      default: "./src/node.ts",
    });
    expect(packageJson.exports["./effect"]).toBe("./src/effect.ts");
    expect(packageJson.exports["./openapi.json"]).toBe("./src/generated/openapi.json");
    expect(packageJson.exports["./bun"]).toBeUndefined();
    expect(packageJson.exports["./node"]).toBeUndefined();
    expect(openApiDocument.openapi).toBe("3.0.0");
  });

  test("exports a stable raw OpenAPI operation id map", () => {
    expect(Object.keys(effectModule.openApiOperationIdMap)).toHaveLength(
      Object.keys(effectModule.operationDefinitions).length,
    );
    expect(effectModule.openApiOperationIdMap["v1-authorize-user"]).toBe("v1AuthorizeUser");
    expect(effectModule.openApiOperationIdMap["v1-diff-a-branch"]).toBe("v1DiffABranch");
    expect(effectModule.openApiOperationIdMap["v1-list-jit-access"]).toBe("v1ListJitAccess");
  });
});
