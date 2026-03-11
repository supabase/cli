import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createStack, type StackHandle } from "../src/bun.ts";

describe("startup timing", () => {
  let stack: StackHandle;
  const transitions: Array<{ name: string; status: string; elapsed: number }> = [];
  let totalStartup: number;

  beforeAll(async () => {
    stack = await createStack();

    const t0 = performance.now();

    // Collect state transitions in background
    const iter = stack.statusChanges();
    (async () => {
      for await (const s of iter) {
        transitions.push({
          name: s.name,
          status: s.status,
          elapsed: performance.now() - t0,
        });
      }
    })();

    await stack.start();
    totalStartup = performance.now() - t0;

    // Let the async iterator drain any remaining queued events
    await new Promise((r) => setTimeout(r, 200));

    // Print per-service lifecycle (Starting → Healthy/Stopped)
    const services = [...new Set(transitions.map((t) => t.name))];
    console.log(`\n  Service lifecycles (total: ${(totalStartup / 1000).toFixed(1)}s):`);
    for (const name of services) {
      const started = transitions.find(
        (t) => t.name === name && (t.status === "Starting" || t.status === "Running"),
      );
      const done = transitions.findLast(
        (t) => t.name === name && (t.status === "Healthy" || t.status === "Stopped"),
      );
      if (started && done) {
        const duration = ((done.elapsed - started.elapsed) / 1000).toFixed(2);
        const from = (started.elapsed / 1000).toFixed(2);
        console.log(`    ${name}: ${duration}s (started at ${from}s)`);
      }
    }
    console.log();
  }, 30_000);

  afterAll(async () => {
    await stack?.dispose();
  }, 15_000);

  const healthCheckDuration = (name: string) => {
    const running = transitions.find((t) => t.name === name && t.status === "Running");
    const healthy = transitions.find((t) => t.name === name && t.status === "Healthy");
    if (!running || !healthy) return Infinity;
    return healthy.elapsed - running.elapsed;
  };

  const timeToStatus = (name: string, status: string) => {
    const t = transitions.find((t) => t.name === name && t.status === status);
    return t?.elapsed ?? Infinity;
  };

  test("total startup under 20s", () => {
    expect(totalStartup).toBeLessThan(20_000);
  });

  test("postgres healthy under 8s", () => {
    expect(timeToStatus("postgres", "Healthy")).toBeLessThan(8_000);
  });

  test("postgres health check latency under 4s", () => {
    expect(healthCheckDuration("postgres")).toBeLessThan(4_000);
  });

  test("postgrest health check latency under 3s", () => {
    expect(healthCheckDuration("postgrest")).toBeLessThan(3_000);
  });

  test("auth health check latency under 3s", () => {
    expect(healthCheckDuration("auth")).toBeLessThan(3_000);
  });
});
