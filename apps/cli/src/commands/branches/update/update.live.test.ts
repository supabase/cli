import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import {
  removeLiveBranch,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("renames a preview branch", async ({ cli, project }) => {
  const name = `cli-e2e-update-${randomUUID().slice(0, 8)}`;
  const renamed = `${name}-renamed`;
  let branchRef: string | undefined;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    const created = await cli([
      "branches",
      "create",
      name,
      "--project-ref",
      project.ref,
      "--output-format",
      "json",
    ]);
    requireLiveSuccess(created, "branches create");
    branchRef = (JSON.parse(created.stdout) as { project_ref: string }).project_ref;
    expect(branchRef, created.stdout).toBeTruthy();

    // `--output json` keeps stdout payload-only and sends the confirmation to stderr.
    const updated = await cli([
      "branches",
      "update",
      name,
      "--project-ref",
      project.ref,
      "--name",
      renamed,
      "--output",
      "json",
    ]);
    expect(updated.exitCode, updated.stderr).toBe(0);
    expect(updated.stderr).toContain("Updated preview branch");
    expect(JSON.parse(updated.stdout)).toMatchObject({ name: renamed });

    // The platform can still 404 the rename right after it completes, so this polls (2s apart,
    // 60s deadline) until it resolves, aborting immediately on anything but a 404. Checks stderr
    // only since `get` prints secrets on stdout.
    const prove = async (): Promise<string> => {
      const proof = await cli(["branches", "get", renamed, "--project-ref", project.ref], {
        exitTimeoutMs: 20_000,
      });
      if (proof.exitCode === 0) return "found";
      if (!/status 404\b/u.test(proof.stderr)) {
        throw new Error(
          `branches get ${renamed} failed (exit ${proof.exitCode})\nstderr:\n${proof.stderr}`,
        );
      }
      return `not found (exit ${proof.exitCode})\nstderr:\n${proof.stderr}`;
    };
    if ((await prove()) !== "found") {
      await expect
        .poll(prove, {
          interval: 2_000,
          timeout: 60_000,
          message: `branches get ${renamed} still does not find the renamed branch`,
        })
        .toBe("found");
    }
  } catch (error) {
    targetError = error;
  } finally {
    try {
      await removeLiveBranch(cli, project, branchRef ?? name);
    } catch (error) {
      cleanupError = error;
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
