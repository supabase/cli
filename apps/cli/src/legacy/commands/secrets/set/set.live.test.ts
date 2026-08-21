import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { test } from "../../../../../tests/helpers/live.ts";

async function unsetSecret(
  cli: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  name: string,
  ref: string,
): Promise<void> {
  const cleanup = await cli(["secrets", "unset", name, "--project-ref", ref, "--yes"]);
  if (cleanup.exitCode !== 0) {
    throw new Error(`secrets unset cleanup failed:\n${cleanup.stdout}\n${cleanup.stderr}`);
  }
}

test("sets a secret on the remote project", async ({ cli, project }) => {
  const name = `CLI_E2E_SET_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const result = await cli(["secrets", "set", `${name}=live-value`, "--project-ref", project.ref]);
  try {
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Finished");
  } finally {
    await unsetSecret(cli, name, project.ref);
  }
});
