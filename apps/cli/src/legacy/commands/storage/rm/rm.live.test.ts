import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";

const STORAGE_FLAGS = ["--linked", "--experimental"];

async function removeObject(
  cli: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  remote: string,
): Promise<void> {
  const removed = await cli(["storage", "rm", remote, "--yes", ...STORAGE_FLAGS]);
  if (
    removed.exitCode !== 0 &&
    !/not found|does not exist/i.test(`${removed.stdout}\n${removed.stderr}`)
  ) {
    throw new Error(`storage rm cleanup failed:\n${removed.stdout}\n${removed.stderr}`);
  }
}

test("removes an uploaded object", async ({ cli, project, workspace }) => {
  const suffix = randomUUID().slice(0, 8);
  const local = join(workspace.path, `upload-${suffix}.txt`);
  const remote = `ss:///${project.storageBucket}/upload-${suffix}.txt`;
  await writeFile(local, "live-e2e storage payload\n");

  let targetError: unknown;
  let cleanupError: unknown;
  try {
    const linked = await cli(["link", "--project-ref", project.ref], {
      env: { SUPABASE_DB_PASSWORD: project.dbPassword },
    });
    requireLiveSuccess(linked, "link setup for storage rm");
    const uploaded = await cli(["storage", "cp", local, remote, ...STORAGE_FLAGS]);
    requireLiveSuccess(uploaded, "storage cp setup for storage rm");

    const result = await cli(["storage", "rm", remote, "--yes", ...STORAGE_FLAGS]);
    expect(result.exitCode, result.stderr).toBe(0);
  } catch (error) {
    targetError = error;
  } finally {
    try {
      await removeObject(cli, remote);
    } catch (error) {
      cleanupError = error;
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
