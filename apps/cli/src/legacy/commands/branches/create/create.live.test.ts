import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { test } from "../../../../../tests/helpers/live.ts";

async function deleteBranch(
  cli: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  name: string,
  ref: string,
): Promise<void> {
  const deleted = await cli(["branches", "delete", name, "--project-ref", ref, "--yes"]);
  if (deleted.exitCode !== 0) {
    throw new Error(
      `branches delete cleanup failed (exit ${deleted.exitCode})\n${deleted.stdout}\n${deleted.stderr}`,
    );
  }
}

test("creates a preview branch", async ({ cli, project }) => {
  const name = `cli-e2e-create-${randomUUID().slice(0, 8)}`;
  const result = await cli(["branches", "create", name, "--project-ref", project.ref]);
  expect(result.exitCode, result.stderr).toBe(0);

  try {
    expect(result.stdout).toContain("Created preview branch");
  } finally {
    await deleteBranch(cli, name, project.ref);
  }
});
