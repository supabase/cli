import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import {
  removeLiveBranch,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("disables preview branching", async ({ cli, project }) => {
  const name = `cli-e2e-disable-${randomUUID().slice(0, 8)}`;
  let mayExist = false;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    // `branches disable` is project-wide and leaves branching off for the rest
    // of the serial run. Creating then deleting a branch proves branching was
    // on, so the assertion below disables a real, empty branching setup rather
    // than a no-op; sibling tests each create their own branch first, which
    // re-enables branching for them.
    mayExist = true;
    const created = await cli(["branches", "create", name, "--project-ref", project.ref]);
    requireLiveSuccess(created, "branches create");

    const removed = await cli(["branches", "delete", name, "--project-ref", project.ref, "--yes"]);
    if (removed.exitCode === 0) mayExist = false;
    requireLiveSuccess(removed, "branches delete");

    const disabled = await cli(["branches", "disable", "--project-ref", project.ref]);
    expect(disabled.exitCode, disabled.stderr).toBe(0);
    expect(disabled.stdout).toContain(`Disabled preview branching for project: ${project.ref}`);
  } catch (error) {
    targetError = error;
  } finally {
    if (mayExist) {
      try {
        await removeLiveBranch(cli, project, name);
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
