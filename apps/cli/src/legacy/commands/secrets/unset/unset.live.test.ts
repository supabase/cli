import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { requireLiveSuccess, testLiveProject } from "../../../../../tests/helpers/live-context.ts";

async function unsetSecret(
  run: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  name: string,
  projectRef: string,
): Promise<void> {
  const cleanup = await run(["secrets", "unset", name, "--project-ref", projectRef, "--yes"]);
  if (cleanup.exitCode !== 0 && !/not found/i.test(`${cleanup.stdout}\n${cleanup.stderr}`)) {
    throw new Error(`secrets unset cleanup failed:\n${cleanup.stdout}\n${cleanup.stderr}`);
  }
}

testLiveProject("unsets a secret from the remote project", async ({ run, projectRef }) => {
  const name = `CLI_E2E_UNSET_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const created = await run(["secrets", "set", `${name}=live-value`, "--project-ref", projectRef]);
  requireLiveSuccess(created, "secrets set setup");

  let deleted = false;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    const result = await run(["secrets", "unset", name, "--project-ref", projectRef, "--yes"]);
    expect(result.exitCode, result.stderr).toBe(0);
    deleted = true;
    expect(result.stdout).toContain("Finished");
  } catch (error) {
    targetError = error;
  } finally {
    if (!deleted) {
      try {
        await unsetSecret(run, name, projectRef);
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (targetError !== undefined) throw targetError;
  if (cleanupError !== undefined) throw cleanupError;
});
