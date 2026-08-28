import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import {
  liveMigrationVersion,
  queryLiveDb,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../../tests/helpers/live.ts";

test("amends the migration history status on the remote database", async ({
  cli,
  project,
  workspace,
}) => {
  const version = liveMigrationVersion();
  const migrations = join(workspace.path, "supabase", "migrations");
  await mkdir(migrations, { recursive: true });
  const migrationFile = join(migrations, `${version}_e2e_repair.sql`);
  // `repair --status applied` records the file's statements in migration
  // history without executing them, so this table is never actually created.
  await writeFile(migrationFile, `create table if not exists e2e_repair_${version} (id int);\n`);

  let targetError: unknown;
  let versionReverted = false;
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

    const recorded = await queryLiveDb(
      project.dbUrl,
      "select version from supabase_migrations.schema_migrations where version = $1",
      [version],
    );
    expect(recorded).toHaveLength(1);

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
    versionReverted = true;

    const remaining = await queryLiveDb(
      project.dbUrl,
      "select version from supabase_migrations.schema_migrations where version = $1",
      [version],
    );
    expect(remaining).toHaveLength(0);
  } catch (error) {
    targetError = error;
  } finally {
    if (!versionReverted) {
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
  }
  throwWithCleanup(targetError, cleanupErrors);
});
