import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { test } from "../../../../../tests/helpers/live.ts";

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

test("sets a secret on the remote project", async ({ run, projectRef }) => {
  const name = `CLI_E2E_SET_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const result = await run(["secrets", "set", `${name}=live-value`, "--project-ref", projectRef]);
  try {
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Finished");
  } finally {
    await unsetSecret(run, name, projectRef);
  }
});
