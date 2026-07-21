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
  let connections = 0;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    server = createServer((socket) => {
      connections += 1;
      sockets.add(socket);
      // Aborted requests reset the connection; without a listener the
      // server-side ECONNRESET becomes an uncaught exception.
      socket.on("error", () => {});
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
        // spawnSupabase disables telemetry for every test by default; this
        // test exists to exercise it, so turn it back on explicitly.
        SUPABASE_TELEMETRY_DISABLED: "0",
        DO_NOT_TRACK: "0",
        SUPABASE_TELEMETRY_POSTHOG_KEY: "phc_e2e_blackhole_test",
        SUPABASE_TELEMETRY_POSTHOG_HOST: host,
      },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Telemetry is enabled.");
    expect(stderr).toBe("");
    // Telemetry must have actually reached the blackhole, otherwise the
    // timing assertion below passes vacuously with telemetry off.
    expect(connections).toBeGreaterThanOrEqual(1);
    expect(elapsedMs).toBeLessThan(3_500);
  });
});
