import { expect } from "vitest";

import {
  expectPostgresConfigLiveOverride,
  experimentalProjectLiveFlags,
  removePostgresConfigLiveOverride,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../../tests/helpers/live.ts";

// Seeds its own override and proves it landed before deleting, so the absence
// assertion cannot be satisfied by the pre-seed state. Teardown removes the
// seeded key only when the test did not already prove it gone.
test("removes the test-seeded override and get proves it is gone", async ({ cli, project }) => {
  const flags = experimentalProjectLiveFlags(project);
  let targetError: unknown;
  const cleanupErrors: Array<unknown> = [];
  let cleanupNeeded = true;
  try {
    const seeded = await cli([
      "postgres-config",
      "update",
      "--config",
      "maintenance_work_mem=16MB",
      ...flags,
      "--no-restart",
    ]);
    requireLiveSuccess(seeded, "postgres-config update setup for postgres-config delete");
    await expectPostgresConfigLiveOverride(
      cli,
      project,
      "maintenance_work_mem",
      "16MB",
      "postgres-config get seed proof for postgres-config delete",
    );

    const removed = await cli([
      "postgres-config",
      "delete",
      "--config",
      "maintenance_work_mem",
      ...flags,
      "--no-restart",
      "-o",
      "json",
    ]);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(removed.stdout, removed.stderr).not.toBe("");
    const remaining = JSON.parse(removed.stdout) as Record<string, unknown>;
    expect(remaining["maintenance_work_mem"], removed.stdout).toBeUndefined();

    await expectPostgresConfigLiveOverride(
      cli,
      project,
      "maintenance_work_mem",
      undefined,
      "postgres-config get proof for postgres-config delete",
    );
    cleanupNeeded = false;
  } catch (error) {
    targetError = error;
  } finally {
    if (cleanupNeeded) {
      try {
        await removePostgresConfigLiveOverride(cli, project, "maintenance_work_mem");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  throwWithCleanup(targetError, cleanupErrors);
});
