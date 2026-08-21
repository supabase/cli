import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";

async function unsetSecret(
  cli: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  name: string,
  ref: string,
): Promise<void> {
  const cleanup = await cli(["secrets", "unset", name, "--project-ref", ref, "--yes"]);
  if (cleanup.exitCode !== 0 && !/not found/i.test(`${cleanup.stdout}\n${cleanup.stderr}`)) {
    throw new Error(`secrets unset cleanup failed:\n${cleanup.stdout}\n${cleanup.stderr}`);
  }
}

test("unsets a secret from the remote project", async ({ cli, project }) => {
  const name = `CLI_E2E_UNSET_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const created = await cli(["secrets", "set", `${name}=live-value`, "--project-ref", project.ref]);
  requireLiveSuccess(created, "secrets set setup");

  let deleted = false;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    const result = await cli(["secrets", "unset", name, "--project-ref", project.ref, "--yes"]);
    expect(result.exitCode, result.stderr).toBe(0);
    deleted = true;
    expect(result.stdout).toContain("Finished");
  } catch (error) {
    targetError = error;
  } finally {
    if (!deleted) {
      try {
        await unsetSecret(cli, name, project.ref);
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
