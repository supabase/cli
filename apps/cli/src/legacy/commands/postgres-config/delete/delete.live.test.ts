import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";

// Seeds its own override and proves it landed before deleting, so the absence
// assertion cannot be satisfied by the pre-seed state; the test leaves the
// shared project unchanged.
test("removes the test-seeded override and get proves it is gone", async ({ cli, project }) => {
  const target = ["--project-ref", project.ref, "--experimental"];
  const noRestart = [...target, "--no-restart"];
  let targetError: unknown;
  const cleanupErrors: Array<unknown> = [];
  try {
    const seeded = await cli([
      "postgres-config",
      "update",
      "--config",
      "maintenance_work_mem=16MB",
      ...noRestart,
    ]);
    requireLiveSuccess(seeded, "postgres-config update setup for postgres-config delete");
    const before = await cli(["postgres-config", "get", ...target, "-o", "json"]);
    requireLiveSuccess(before, "postgres-config get seed proof for postgres-config delete");
    expect(before.stdout, before.stderr).not.toBe("");
    const seededConfig = JSON.parse(before.stdout) as Record<string, unknown>;
    expect(seededConfig["maintenance_work_mem"], before.stdout).toBe("16MB");

    const removed = await cli([
      "postgres-config",
      "delete",
      "--config",
      "maintenance_work_mem",
      ...noRestart,
    ]);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(removed.stdout, removed.stderr).toContain("Parameter");
    expect(removed.stdout, removed.stderr).not.toContain("maintenance_work_mem");

    const proof = await cli(["postgres-config", "get", ...target, "-o", "json"]);
    requireLiveSuccess(proof, "postgres-config get proof for postgres-config delete");
    expect(proof.stdout, proof.stderr).not.toBe("");
    const config = JSON.parse(proof.stdout) as Record<string, unknown>;
    expect(config["maintenance_work_mem"], proof.stdout).toBeUndefined();
  } catch (error) {
    targetError = error;
  } finally {
    try {
      const restored = await cli([
        "postgres-config",
        "delete",
        "--config",
        "maintenance_work_mem",
        ...noRestart,
      ]);
      requireLiveSuccess(restored, "postgres-config delete cleanup after postgres-config delete");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwWithCleanup(targetError, cleanupErrors);
});
