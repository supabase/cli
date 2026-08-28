import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";
import { legacyRemoveStorageLiveObject, legacyStorageLiveFlags } from "../storage.live-helpers.ts";

test("copies a local file to the remote bucket", async ({ cli, project, workspace }) => {
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
    requireLiveSuccess(linked, "link setup for storage cp");

    const result = await cli(["storage", "cp", local, remote, ...legacyStorageLiveFlags]);
    expect(result.exitCode, result.stderr).toBe(0);
  } catch (error) {
    targetError = error;
  } finally {
    try {
      await legacyRemoveStorageLiveObject(cli, remote);
    } catch (error) {
      cleanupError = error;
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
