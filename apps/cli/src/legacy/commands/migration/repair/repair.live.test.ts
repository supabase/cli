import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";

test("amends the migration history status on the remote database", async ({
  cli,
  project,
  workspace,
}) => {
  const version = `${Date.now()}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, "0")}`;
  const migrations = join(workspace.path, "supabase", "migrations");
  await mkdir(migrations, { recursive: true });
  const migrationFile = join(migrations, `${version}_e2e_repair.sql`);
  await writeFile(migrationFile, `create table if not exists e2e_repair_${version} (id int);\n`);

  let targetError: unknown;
  const cleanupErrors: Array<unknown> = [];
  try {
    const applied = await cli([
      "migration",
      "repair",
      version,
      "--status",
      "applied",
      "--db-url",
      project.dbUrl,
    ]);
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(applied.stderr, applied.stdout).toContain("=> applied");
    await unlink(migrationFile);

    const listed = await cli(["migration", "list", "--db-url", project.dbUrl]);
    requireLiveSuccess(listed, "migration list proof for migration repair");
    expect(listed.stdout, listed.stderr).toContain(version);

    const reverted = await cli([
      "migration",
      "repair",
      version,
      "--status",
      "reverted",
      "--db-url",
      project.dbUrl,
    ]);
    expect(reverted.exitCode, reverted.stderr).toBe(0);
    expect(reverted.stderr, reverted.stdout).toContain("=> reverted");

    const relisted = await cli(["migration", "list", "--db-url", project.dbUrl]);
    requireLiveSuccess(relisted, "migration list proof after revert");
    expect(relisted.stdout, relisted.stderr).not.toContain(version);
  } catch (error) {
    targetError = error;
  } finally {
    try {
      const cleanup = await cli([
        "migration",
        "repair",
        version,
        "--status",
        "reverted",
        "--db-url",
        project.dbUrl,
      ]);
      requireLiveSuccess(cleanup, "migration repair cleanup");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwWithCleanup(targetError, cleanupErrors);
});
