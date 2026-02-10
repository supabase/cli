import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { createProcessCompose, type ProcessCompose } from "../src/index.ts";

const TEST_CONFIG_PATH = join(import.meta.dir, "fixtures/test-config.yaml");

interface TestServer {
  pc: ProcessCompose;
  apiUrl: string;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Creates a disposable test server with a dynamically allocated port
 */
async function createTestServer(): Promise<TestServer> {
  // Use port 0 to let the OS pick an available port
  const pc = await createProcessCompose({
    configPath: TEST_CONFIG_PATH,
    apiPort: 0,
    startApi: true,
  });

  // Start API server but don't start processes yet
  pc.api?.start();

  const apiUrl = pc.api?.url ?? "";

  return {
    pc,
    apiUrl,
    async [Symbol.asyncDispose]() {
      await pc.stop();
    },
  };
}

describe("Process Compose API", () => {
  describe("GET /live", () => {
    test("returns alive status", async () => {
      await using server = await createTestServer();

      const res = await fetch(`${server.apiUrl}/live`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ status: "alive" });
    });
  });

  describe("GET /project/name", () => {
    test("returns project name", async () => {
      await using server = await createTestServer();

      const res = await fetch(`${server.apiUrl}/project/name`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ projectName: "test-project" });
    });
  });

  describe("GET /processes", () => {
    test("returns all processes", async () => {
      await using server = await createTestServer();

      const res = await fetch(`${server.apiUrl}/processes`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as { data: { name: string }[] };
      expect(data).toHaveProperty("data");
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBe(3);

      const names = data.data.map((p) => p.name);
      expect(names).toContain("init");
      expect(names).toContain("server");
      expect(names).toContain("worker");
    });
  });

  describe("GET /process/:name", () => {
    test("returns process state for existing process", async () => {
      await using server = await createTestServer();

      const res = await fetch(`${server.apiUrl}/process/init`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as {
        name: string;
        status: string;
        health: string;
        isRunning: boolean;
      };
      expect(data.name).toBe("init");
      expect(data).toHaveProperty("status");
      expect(data).toHaveProperty("health");
      expect(data).toHaveProperty("isRunning");
    });

    test("returns 404 for non-existent process", async () => {
      await using server = await createTestServer();

      const res = await fetch(`${server.apiUrl}/process/nonexistent`);
      expect(res.status).toBe(404);

      const data = await res.json();
      expect(data).toHaveProperty("error");
    });
  });

  describe("POST /process/start/:name", () => {
    test("starts a process", async () => {
      await using server = await createTestServer();

      const res = await fetch(`${server.apiUrl}/process/start/init`, {
        method: "POST",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ name: "init" });

      // Verify it ran
      const stateRes = await fetch(`${server.apiUrl}/process/init`);
      const state = (await stateRes.json()) as { status: string };
      expect(["Completed", "Ready", "Running"]).toContain(state.status);
    });

    test("returns 400 for non-existent process", async () => {
      await using server = await createTestServer();

      const res = await fetch(`${server.apiUrl}/process/start/nonexistent`, {
        method: "POST",
      });
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data).toHaveProperty("error");
    });
  });

  describe("POST /process/restart/:name", () => {
    test("restarts a completed process", async () => {
      await using server = await createTestServer();

      const res = await fetch(`${server.apiUrl}/process/restart/init`, {
        method: "POST",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ name: "init" });
    });
  });

  describe("GET /process/logs/:name/:offset/:limit", () => {
    test("returns logs for a process", async () => {
      await using server = await createTestServer();

      const res = await fetch(`${server.apiUrl}/process/logs/init/0/100`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as { logs: unknown[] };
      expect(data).toHaveProperty("logs");
      expect(Array.isArray(data.logs)).toBe(true);
    });

    test("returns empty logs for process with no output", async () => {
      await using server = await createTestServer();

      const res = await fetch(`${server.apiUrl}/process/logs/worker/0/100`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as { logs: unknown[] };
      expect(data).toHaveProperty("logs");
      expect(Array.isArray(data.logs)).toBe(true);
    });
  });

  describe("DELETE /process/logs/:name", () => {
    test("truncates process logs", async () => {
      await using server = await createTestServer();

      const res = await fetch(`${server.apiUrl}/process/logs/init`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ name: "init" });

      // Verify logs are empty
      const logsRes = await fetch(`${server.apiUrl}/process/logs/init/0/100`);
      const logsData = (await logsRes.json()) as { logs: unknown[] };
      expect(logsData.logs).toEqual([]);
    });
  });

  describe("PATCH /process/stop/:name", () => {
    test(
      "stops a running process",
      async () => {
        await using server = await createTestServer();

        // Start server first
        await fetch(`${server.apiUrl}/process/start/server`, { method: "POST" });

        const res = await fetch(`${server.apiUrl}/process/stop/server`, {
          method: "PATCH",
        });
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data).toEqual({ name: "server" });

        // Verify it stopped
        const stateRes = await fetch(`${server.apiUrl}/process/server`);
        const state = (await stateRes.json()) as { status: string };
        expect(["Completed", "Error", "Terminating"]).toContain(state.status);
      },
      { timeout: 15000 },
    );
  });

  describe("POST /project/stop", () => {
    test("stops all processes", async () => {
      await using server = await createTestServer();

      const res = await fetch(`${server.apiUrl}/project/stop`, {
        method: "POST",
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ status: "stopping" });
    });
  });

  describe("Unknown routes", () => {
    test("returns 404 for unknown routes", async () => {
      await using server = await createTestServer();

      const res = await fetch(`${server.apiUrl}/unknown/route`);
      expect(res.status).toBe(404);

      const data = await res.json();
      expect(data).toEqual({ error: "Not found" });
    });
  });
});
