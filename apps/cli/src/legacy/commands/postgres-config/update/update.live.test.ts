import { expect } from "vitest";

import {
  postgresConfigLiveFlags,
  removePostgresConfigLiveOverride,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../../tests/helpers/live.ts";

// --no-restart skips the database restart; work_mem is a dynamic parameter, so
// the override still takes effect.
test("applies an override with --no-restart and get proves it", async ({ cli, project }) => {
  const flags = postgresConfigLiveFlags(project);
  let targetError: unknown;
  const cleanupErrors: Array<unknown> = [];
  try {
    const updated = await cli([
      "postgres-config",
      "update",
      "--config",
      "work_mem=7MB",
      ...flags,
      "--no-restart",
      "-o",
      "json",
    ]);
    expect(updated.exitCode, updated.stderr).toBe(0);
    expect(updated.stdout, updated.stderr).not.toBe("");
    const applied = JSON.parse(updated.stdout) as Record<string, unknown>;
    expect(applied["work_mem"], updated.stdout).toBe("7MB");

    const proof = await cli(["postgres-config", "get", ...flags, "-o", "json"]);
    requireLiveSuccess(proof, "postgres-config get proof for postgres-config update");
    expect(proof.stdout, proof.stderr).not.toBe("");
    const config = JSON.parse(proof.stdout) as Record<string, unknown>;
    expect(config["work_mem"], proof.stdout).toBe("7MB");
  } catch (error) {
    targetError = error;
  } finally {
    try {
      await removePostgresConfigLiveOverride(cli, project, "work_mem");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwWithCleanup(targetError, cleanupErrors);
});
