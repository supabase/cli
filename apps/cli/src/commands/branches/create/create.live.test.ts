import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { removeLiveBranch, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";

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
      await removeLiveBranch(cli, project, name);
    } catch (error) {
      cleanupError = error;
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
