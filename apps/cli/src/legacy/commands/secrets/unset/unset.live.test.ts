import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { requireLiveSuccess, testLiveProject } from "../../../../../tests/helpers/live-context.ts";

async function unsetSecret(
  run: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  name: string,
  projectRef: string,
): Promise<void> {
  const cleanup = await run(["secrets", "unset", name, "--project-ref", projectRef, "--yes"]);
  if (cleanup.exitCode !== 0) {
    throw new Error(`secrets unset cleanup failed:\n${cleanup.stdout}\n${cleanup.stderr}`);
  }
}

testLiveProject("unsets a secret from the remote project", async ({ run, projectRef }) => {
  const name = `CLI_E2E_UNSET_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const created = await run(["secrets", "set", `${name}=live-value`, "--project-ref", projectRef]);
  requireLiveSuccess(created, "secrets set setup");

  try {
    const result = await run(["secrets", "unset", name, "--project-ref", projectRef, "--yes"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Finished");
  } finally {
    await unsetSecret(run, name, projectRef);
  }
});
