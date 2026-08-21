import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { requireLiveSuccess, test } from "../../../../../tests/helpers/live.ts";

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

test("lists a secret created on the remote project", async ({ run, projectRef }) => {
  const name = `CLI_E2E_LIST_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const created = await run(["secrets", "set", `${name}=live-value`, "--project-ref", projectRef]);
  requireLiveSuccess(created, "secrets set setup");

  try {
    const result = await run(["secrets", "list", "--output", "json", "--project-ref", projectRef]);
    expect(result.exitCode, result.stderr).toBe(0);
    const names = (JSON.parse(result.stdout) as Array<{ name: string }>).map(
      (secret) => secret.name,
    );
    expect(names).toContain(name);
  } finally {
    await unsetSecret(run, name, projectRef);
  }
});
