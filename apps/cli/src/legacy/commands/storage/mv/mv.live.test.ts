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

test("moves an uploaded object to a new path", async ({ cli, project, workspace }) => {
  const suffix = randomUUID().slice(0, 8);
  const local = join(workspace.path, `mv-src-${suffix}.txt`);
  const source = `ss:///${project.storageBucket}/mv-src-${suffix}.txt`;
  const destination = `ss:///${project.storageBucket}/mv-dst-${suffix}.txt`;
  await writeFile(local, "live-e2e storage payload\n");

  let targetError: unknown;
  const cleanupErrors: Array<unknown> = [];
  try {
    const linked = await cli(["link", "--project-ref", project.ref], {
      env: { SUPABASE_DB_PASSWORD: project.dbPassword },
    });
    requireLiveSuccess(linked, "link setup for storage mv");
    const uploaded = await cli(["storage", "cp", local, source, ...STORAGE_FLAGS]);
    requireLiveSuccess(uploaded, "storage cp setup for storage mv");

    const moved = await cli(["storage", "mv", source, destination, ...STORAGE_FLAGS]);
    expect(moved.exitCode, moved.stderr).toBe(0);
    expect(moved.stderr, moved.stderr).toContain("Moving object:");

    const listed = await cli([
      "storage",
      "ls",
      `ss:///${project.storageBucket}/`,
      ...STORAGE_FLAGS,
    ]);
    requireLiveSuccess(listed, "storage ls proof for storage mv");
    expect(listed.stdout).toContain(`mv-dst-${suffix}.txt`);
    expect(listed.stdout).not.toContain(`mv-src-${suffix}.txt`);
  } catch (error) {
    targetError = error;
  } finally {
    for (const remote of [destination, source]) {
      try {
        await removeObject(cli, remote);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  throwWithCleanup(targetError, cleanupErrors);
});
