import { expect } from "vitest";

import {
  experimentalProjectLiveFlags,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../../tests/helpers/live.ts";

function enforcementFlag(enforce: boolean): string {
  return enforce ? "--enable-db-ssl-enforcement" : "--disable-db-ssl-enforcement";
}

test("toggles enforcement, get proves it, and restores the captured posture", async ({
  cli,
  project,
}) => {
  const flags = experimentalProjectLiveFlags(project);
  const captured = await cli(["ssl-enforcement", "get", ...flags, "-o", "json"]);
  requireLiveSuccess(captured, "ssl-enforcement get capture for ssl-enforcement update");
  expect(captured.stdout, captured.stderr).not.toBe("");
  const posture = (JSON.parse(captured.stdout) as { currentConfig: { database: boolean } })
    .currentConfig.database;
  let targetError: unknown;
  const cleanupErrors: Array<unknown> = [];
  try {
    const updated = await cli([
      "ssl-enforcement",
      "update",
      enforcementFlag(!posture),
      ...flags,
      "-o",
      "json",
    ]);
    expect(updated.exitCode, updated.stderr).toBe(0);
    expect(updated.stdout, updated.stderr).not.toBe("");
    expect(JSON.parse(updated.stdout), updated.stdout).toMatchObject({
      currentConfig: { database: !posture },
    });

    const proof = await cli(["ssl-enforcement", "get", ...flags, "-o", "json"]);
    requireLiveSuccess(proof, "ssl-enforcement get proof for ssl-enforcement update");
    expect(proof.stdout, proof.stderr).not.toBe("");
    expect(JSON.parse(proof.stdout), proof.stdout).toMatchObject({
      currentConfig: { database: !posture },
    });
  } catch (error) {
    targetError = error;
  } finally {
    try {
      const restored = await cli(["ssl-enforcement", "update", enforcementFlag(posture), ...flags]);
      requireLiveSuccess(restored, "ssl-enforcement update restore of the captured posture");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwWithCleanup(targetError, cleanupErrors);
});
