import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { requireLiveSuccess, testLiveStorage } from "../../../../../tests/helpers/live-context.ts";

const STORAGE_FLAGS = ["--linked", "--experimental"];

async function removeObject(
  run: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  remote: string,
): Promise<void> {
  const removed = await run(["storage", "rm", remote, "--yes", ...STORAGE_FLAGS]);
  if (removed.exitCode !== 0) {
    throw new Error(`storage rm cleanup failed:\n${removed.stdout}\n${removed.stderr}`);
  }
}

testLiveStorage(
  "removes an uploaded object",
  async ({ run, projectRef, dbPassword, storageBucket, workspace }) => {
    const suffix = randomUUID().slice(0, 8);
    const local = join(workspace.path, `upload-${suffix}.txt`);
    const remote = `ss:///${storageBucket}/upload-${suffix}.txt`;
    await writeFile(local, "live-e2e storage payload\n");

    const linked = await run(["link", "--project-ref", projectRef], {
      env: { SUPABASE_DB_PASSWORD: dbPassword },
    });
    requireLiveSuccess(linked, "link setup for storage rm");
    const uploaded = await run(["storage", "cp", local, remote, ...STORAGE_FLAGS]);
    requireLiveSuccess(uploaded, "storage cp setup for storage rm");

    let removed = false;
    try {
      const result = await run(["storage", "rm", remote, "--yes", ...STORAGE_FLAGS]);
      expect(result.exitCode, result.stderr).toBe(0);
      removed = true;
    } finally {
      if (!removed) await removeObject(run, remote);
    }
  },
);
