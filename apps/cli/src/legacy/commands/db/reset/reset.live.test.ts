import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";

test("resets the remote database with local migrations", async ({ cli, project, workspace }) => {
  const version = `${Date.now()}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, "0")}`;
  const migrations = join(workspace.path, "supabase", "migrations");
  await mkdir(migrations, { recursive: true });
  const migrationFile = join(migrations, `${version}_e2e_reset.sql`);
  await writeFile(migrationFile, `create table if not exists e2e_reset_${version} (id int);\n`);

  let targetError: unknown;
  const cleanupErrors: Array<unknown> = [];
  try {
    const result = await cli(["db", "reset", "--db-url", project.dbUrl, "--yes"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Resetting remote database");
  } catch (error) {
    targetError = error;
  } finally {
    await unlink(migrationFile).catch((error) => cleanupErrors.push(error));
    try {
      const reset = await cli(["db", "reset", "--db-url", project.dbUrl, "--yes"]);
      requireLiveSuccess(reset, "db reset cleanup");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwWithCleanup(targetError, cleanupErrors);
});
