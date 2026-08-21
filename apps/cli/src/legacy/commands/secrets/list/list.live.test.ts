import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { requireLiveSuccess, test } from "../../../../../tests/helpers/live.ts";

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

test("lists a secret created on the remote project", async ({ cli, project }) => {
  const name = `CLI_E2E_LIST_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const created = await cli(["secrets", "set", `${name}=live-value`, "--project-ref", project.ref]);
  requireLiveSuccess(created, "secrets set setup");

  try {
    const result = await cli(["secrets", "list", "--output", "json", "--project-ref", project.ref]);
    expect(result.exitCode, result.stderr).toBe(0);
    const names = (JSON.parse(result.stdout) as Array<{ name: string }>).map(
      (secret) => secret.name,
    );
    expect(names).toContain(name);
  } finally {
    await unsetSecret(cli, name, project.ref);
  }
});
