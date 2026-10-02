import { describe, expect, test } from "vitest";
import { createApiClient } from "./bun.ts";

describe("Bun client lifecycle", () => {
  test("serves requests through the Bun entrypoint and rejects operations after disposal", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        paths.push(new URL(request.url).pathname);
        return Response.json([]);
      },
    });
    const client = await createApiClient({
      baseUrl: server.url.toString(),
      accessToken: "test-token",
    });
    try {
      await expect(client.v1.listAllProjects()).resolves.toEqual([]);
      expect(paths).toEqual(["/v1/projects"]);
      await client.dispose();
      await expect(client.v1.listAllProjects()).rejects.toThrow();
      expect(paths).toEqual(["/v1/projects"]);
    } finally {
      await client.dispose();
      await server.stop(true);
    }
  });
});
