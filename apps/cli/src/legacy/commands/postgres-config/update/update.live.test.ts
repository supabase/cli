import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";

// --no-restart skips the database restart; work_mem is a dynamic parameter, so
// the override still takes effect.
test("applies an override with --no-restart and get proves it", async ({ cli, project }) => {
  const target = ["--project-ref", project.ref, "--experimental"];
  const noRestart = [...target, "--no-restart"];
  let targetError: unknown;
  const cleanupErrors: Array<unknown> = [];
  try {
    const updated = await cli([
      "postgres-config",
      "update",
      "--config",
      "work_mem=7MB",
      ...noRestart,
    ]);
    expect(updated.exitCode, updated.stderr).toBe(0);
    expect(updated.stdout, updated.stderr).toMatch(/\bwork_mem +\| 7MB\b/u);

    const proof = await cli(["postgres-config", "get", ...target, "-o", "json"]);
    requireLiveSuccess(proof, "postgres-config get proof for postgres-config update");
    expect(proof.stdout, proof.stderr).not.toBe("");
    const config = JSON.parse(proof.stdout) as Record<string, unknown>;
    expect(config["work_mem"], proof.stdout).toBe("7MB");
  } catch (error) {
    targetError = error;
  } finally {
    try {
      const removed = await cli([
        "postgres-config",
        "delete",
        "--config",
        "work_mem",
        ...noRestart,
      ]);
      requireLiveSuccess(removed, "postgres-config delete cleanup after postgres-config update");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwWithCleanup(targetError, cleanupErrors);
});
