import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";

import {
  liveMigrationVersion,
  removeLiveMigration,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../../tests/helpers/live.ts";

test("lists a seeded remote migration", async ({ cli, project }) => {
  const targetArgs = ["--db-url", project.dbUrl];
  const version = liveMigrationVersion();
  // Seeded outside the workspace so the version can only reach stdout through the remote column.
  const seedDir = await mkdtemp(path.join(tmpdir(), "sb-migration-list-live-"));
  let targetError: unknown;
  const cleanupErrors: Array<unknown> = [];
  try {
    await mkdir(path.join(seedDir, "supabase", "migrations"), { recursive: true });
    await writeFile(
      path.join(seedDir, "supabase", "migrations", `${version}_cli_live_list.sql`),
      "select 1;\n",
    );
    const seeded = await cli(
      ["migration", "repair", version, "--status", "applied", ...targetArgs],
      { cwd: seedDir },
    );
    requireLiveSuccess(seeded, "migration repair setup");

    const result = await cli(["migration", "list", ...targetArgs]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout, result.stderr).toContain(version);
  } catch (error) {
    targetError = error;
  } finally {
    await removeLiveMigration(cli, project, version).catch((error) => cleanupErrors.push(error));
    await rm(seedDir, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error));
  }
  throwWithCleanup(targetError, cleanupErrors);
});
