import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runSupabase } from "../../../tests/helpers/cli.ts";

// A TCP blackhole: accepts connections and never responds, so telemetry
// requests connect and then hang until aborted. Asserting on the spawned
// process's wall-clock exit (not scope or shutdown internals) is deliberate:
// pending sockets keep the runtime alive, so only actual process exit proves
// the telemetry exit cap holds end to end.
describe("telemetry against a blackholed PostHog endpoint", () => {
  let server: Server;
  let host: string;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Failed to allocate a blackhole port");
    }
    host = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("commands exit promptly, cleanly, and quietly", async () => {
    const startedAt = performance.now();
    const { stdout, stderr, exitCode } = await runSupabase(["telemetry", "status"], {
      entrypoint: "legacy",
      env: {
        SUPABASE_TELEMETRY_POSTHOG_KEY: "phc_e2e_blackhole_test",
        SUPABASE_TELEMETRY_POSTHOG_HOST: host,
      },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Telemetry is enabled.");
    expect(stderr).toBe("");
    expect(elapsedMs).toBeLessThan(3_500);
  });
});
