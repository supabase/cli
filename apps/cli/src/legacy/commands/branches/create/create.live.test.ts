// oxlint-disable effecttsgo/async-function -- live tests use Vitest's Promise callback surface to drive the real CLI.
import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";

async function cleanupBranch(
  cli: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  name: string,
  ref: string,
): Promise<void> {
  const deleted = await cli(["branches", "delete", name, "--project-ref", ref, "--yes"]);
  if (
    deleted.exitCode !== 0 &&
    !/not found|does not exist/i.test(`${deleted.stdout}\n${deleted.stderr}`)
  ) {
    throw new Error(
      `branches delete cleanup failed (exit ${deleted.exitCode})\n${deleted.stdout}\n${deleted.stderr}`,
    );
  }
}

test("creates a preview branch", async ({ cli, project }) => {
  const name = `cli-e2e-create-${randomUUID().slice(0, 8)}`;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    const result = await cli(["branches", "create", name, "--project-ref", project.ref]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Created preview branch");
  } catch (error) {
    targetError = error;
  } finally {
    try {
      await cleanupBranch(cli, name, project.ref);
    } catch (error) {
      cleanupError = error;
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
