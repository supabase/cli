import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";

test("applies a test-written migration to the remote database", async ({
  cli,
  project,
  workspace,
}) => {
  const version = `${Date.now()}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, "0")}`;
  const migrations = join(workspace.path, "supabase", "migrations");
  await mkdir(migrations, { recursive: true });
  const migrationFile = join(migrations, `${version}_e2e_up.sql`);
  await writeFile(migrationFile, `create table if not exists e2e_up_${version} (id int);\n`);

  let targetError: unknown;
  const cleanupErrors: Array<unknown> = [];
  try {
    const applied = await cli(["migration", "up", "--db-url", project.dbUrl]);
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(applied.stderr, applied.stdout).toContain("Applying migration");
    await unlink(migrationFile);

    const listed = await cli(["migration", "list", "--db-url", project.dbUrl]);
    requireLiveSuccess(listed, "migration list proof for migration up");
    expect(listed.stdout, listed.stderr).toContain(version);
  } catch (error) {
    targetError = error;
  } finally {
    try {
      await rm(migrationFile, { force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      const reset = await cli(["db", "reset", "--db-url", project.dbUrl, "--yes"]);
      requireLiveSuccess(reset, "db reset cleanup after migration up");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwWithCleanup(targetError, cleanupErrors);
});
