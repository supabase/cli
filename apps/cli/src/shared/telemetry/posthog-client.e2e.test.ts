import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runSupabase } from "../../../tests/helpers/cli.ts";

// A TCP blackhole: accepts connections and never responds, so telemetry
// requests connect and then hang until aborted. Asserting on the spawned
// process's wall-clock exit (not scope or shutdown internals) is deliberate:
// pending sockets keep the runtime alive, so only actual process exit proves
// the telemetry exit cap holds end to end.
describe("telemetry against a blackholed PostHog endpoint", () => {
  let server: { readonly port: number; readonly stop: () => Promise<void> };
  let host: string;
  let connections = 0;

  beforeAll(() => {
    const runningServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        connections += 1;
        return Effect.runPromise(Effect.never);
      },
    });
    const { port } = runningServer;
    if (port === undefined) throw new Error("Failed to allocate a blackhole port");
    server = { port, stop: () => runningServer.stop(true) };
    host = `http://127.0.0.1:${port}`;
  });

  afterAll(() => server.stop());

  test("commands exit promptly, cleanly, and quietly", () => {
    const startedAt = performance.now();
    return runSupabase(["telemetry", "status"], {
      entrypoint: "legacy",
      env: {
        // spawnSupabase disables telemetry for every test by default; this
        // test exists to exercise it, so turn it back on explicitly.
        SUPABASE_TELEMETRY_DISABLED: "0",
        DO_NOT_TRACK: "0",
        SUPABASE_TELEMETRY_POSTHOG_KEY: "phc_e2e_blackhole_test",
        SUPABASE_TELEMETRY_POSTHOG_HOST: host,
      },
    }).then(({ stdout, stderr, exitCode }) => {
      const elapsedMs = performance.now() - startedAt;

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Telemetry is enabled.");
      expect(stderr).toBe("");
      // Telemetry must have actually reached the blackhole, otherwise the
      // timing assertion below passes vacuously with telemetry off.
      expect(connections).toBeGreaterThanOrEqual(1);
      // Healthy runs measure ~2.5s (2s drain cap + spawn overhead); the nearest
      // real failure signature is the SDK's 5s default deadline plus startup.
      expect(elapsedMs).toBeLessThan(4_500);
    });
  });
});
