import { Schema } from "effect";
import { expect } from "vitest";

import {
  experimentalProjectLiveFlags,
  type LiveFixtures,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../../tests/helpers/live.ts";

type LiveCli = LiveFixtures["cli"];

// Bound the polled gets and the restore so one hung subprocess cannot exhaust
// the live testTimeout and leave the shared project with a flipped posture.
const POLL_ATTEMPT_EXIT_TIMEOUT_MS = 20_000;
const RESTORE_EXIT_TIMEOUT_MS = 60_000;

const SslEnforcementPosture = Schema.Struct({
  currentConfig: Schema.Struct({ database: Schema.Boolean }),
  appliedSuccessfully: Schema.Boolean,
});

function enforcementFlag(enforce: boolean): string {
  return enforce ? "--enable-db-ssl-enforcement" : "--disable-db-ssl-enforcement";
}

async function readPosture(
  cli: LiveCli,
  flags: ReadonlyArray<string>,
  label: string,
  exitTimeoutMs?: number,
): Promise<typeof SslEnforcementPosture.Type> {
  const result = await cli(["ssl-enforcement", "get", ...flags, "-o", "json"], { exitTimeoutMs });
  requireLiveSuccess(result, label);
  expect(result.stdout, result.stderr).not.toBe("");
  const payload: unknown = JSON.parse(result.stdout);
  if (!Schema.is(SslEnforcementPosture)(payload)) {
    throw new Error(`${label}: unexpected ssl-enforcement get payload\n${result.stdout}`);
  }
  return payload;
}

// get reports `appliedSuccessfully: false` while a requested posture has not
// propagated yet (see ../get/SIDE_EFFECTS.md), so proving a toggle or a restore
// means polling get until the requested value is reported as applied.
function expectApplied(
  cli: LiveCli,
  flags: ReadonlyArray<string>,
  enforce: boolean,
  label: string,
): Promise<void> {
  return expect
    .poll(() => readPosture(cli, flags, label, POLL_ATTEMPT_EXIT_TIMEOUT_MS), {
      interval: 2_000,
      timeout: 60_000,
      message: label,
    })
    .toEqual({ currentConfig: { database: enforce }, appliedSuccessfully: true });
}

test("toggles enforcement, get proves it, and restores the captured posture", async ({
  cli,
  project,
}) => {
  const flags = experimentalProjectLiveFlags(project);
  const posture = (
    await readPosture(cli, flags, "ssl-enforcement get capture for ssl-enforcement update")
  ).currentConfig.database;
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

    await expectApplied(
      cli,
      flags,
      !posture,
      "ssl-enforcement get proof for ssl-enforcement update",
    );
  } catch (error) {
    targetError = error;
  } finally {
    try {
      const restored = await cli(
        ["ssl-enforcement", "update", enforcementFlag(posture), ...flags],
        {
          exitTimeoutMs: RESTORE_EXIT_TIMEOUT_MS,
        },
      );
      requireLiveSuccess(restored, "ssl-enforcement update restore of the captured posture");
      await expectApplied(
        cli,
        flags,
        posture,
        "ssl-enforcement get proof of the restored posture for ssl-enforcement update",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwWithCleanup(targetError, cleanupErrors);
});
