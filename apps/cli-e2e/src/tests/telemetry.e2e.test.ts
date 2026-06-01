import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { testBehaviour, testParity } from "./test-context.ts";

describe("telemetry", () => {
  describe("telemetry:enable", () => {
    testBehaviour("enables telemetry", async ({ run }) => {
      const result = await run(["telemetry", "enable"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Telemetry is enabled.");
    });

    testBehaviour("exits non-zero on unwritable config dir", async ({ run, workspace }) => {
      chmodSync(workspace.path, 0o555);
      try {
        const result = await run(["telemetry", "enable"]);
        expect(result.exitCode).not.toBe(0);
      } finally {
        chmodSync(workspace.path, 0o755);
      }
    });

    testParity(["telemetry", "enable"]);
    testParity(["telemetry", "enable"], { failureType: "NON_AUTH" });
  });

  describe("telemetry:disable", () => {
    testBehaviour("disables telemetry", async ({ run }) => {
      const result = await run(["telemetry", "disable"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Telemetry is disabled.");
    });

    testParity(["telemetry", "disable"]);
    testParity(["telemetry", "disable"], { failureType: "NON_AUTH" });
  });

  describe("telemetry:status", () => {
    testBehaviour("shows current telemetry state", async ({ run }) => {
      const result = await run(["telemetry", "status"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Telemetry is (enabled|disabled)\./);
    });

    testBehaviour("round-trip: enable then status shows enabled", async ({ run }) => {
      await run(["telemetry", "enable"]);
      const result = await run(["telemetry", "status"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Telemetry is enabled.");
    });

    testBehaviour("round-trip: disable then status shows disabled", async ({ run }) => {
      await run(["telemetry", "disable"]);
      const result = await run(["telemetry", "status"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Telemetry is disabled.");
    });

    testBehaviour("handles corrupted config gracefully", async ({ run, workspace }) => {
      const telemetryPath = join(workspace.path, "telemetry.json");
      writeFileSync(telemetryPath, "{{not valid json}}");
      const result = await run(["telemetry", "status"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Telemetry is (enabled|disabled)\./);
      expect(() => JSON.parse(readFileSync(telemetryPath, "utf8"))).not.toThrow();
    });

    testParity(["telemetry", "status"]);
    testParity(["telemetry", "status"], { failureType: "NON_AUTH" });
  });
});
