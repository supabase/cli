import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { test } from "../../../../../tests/helpers/live.ts";

async function deleteBranch(
  run: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  name: string,
  projectRef: string,
): Promise<void> {
  const deleted = await run(["branches", "delete", name, "--project-ref", projectRef, "--yes"]);
  if (deleted.exitCode !== 0) {
    throw new Error(
      `branches delete cleanup failed (exit ${deleted.exitCode})\n${deleted.stdout}\n${deleted.stderr}`,
    );
  }
}

test("creates a preview branch", async ({ run, projectRef, skip }) => {
  const name = `cli-e2e-create-${randomUUID().slice(0, 8)}`;
  const result = await run(["branches", "create", name, "--project-ref", projectRef]);

  // Branching is plan-gated. A free Supabox org lacks the optional fixture for
  // this golden path, so skip only the recognized plan-gate response.
  if (result.exitCode !== 0) {
    if (/paid plan|upgrade|not.*support/i.test(`${result.stdout}\n${result.stderr}`)) {
      skip("Preview branches require a paid plan");
    }
    expect(result.exitCode, result.stderr).toBe(0);
  }

  try {
    expect(result.stdout).toContain("Created preview branch");
  } finally {
    await deleteBranch(run, name, projectRef);
  }
});
