import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import {
  liveMigrationVersion,
  queryLiveDb,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("applies a test-written migration to the remote database", async ({
  cli,
  project,
  workspace,
}) => {
  const version = liveMigrationVersion();
  const migrations = join(workspace.path, "supabase", "migrations");
  await mkdir(migrations, { recursive: true });

  // The serial suite shares one project; seed a stub for every version already in remote
  // history, or `migration up` rejects it as missing locally.
  let remoteVersions: Array<{ version: string }> = [];
  try {
    remoteVersions = await queryLiveDb(
      project.dbUrl,
      "select version from supabase_migrations.schema_migrations order by version",
    );
  } catch (error) {
    // 42P01 = undefined relation, i.e. a fresh project without the migrations table yet.
    if ((error as { code?: string }).code !== "42P01") throw error;
    remoteVersions = [];
  }
  for (const row of remoteVersions) {
    await writeFile(
      join(migrations, `${row.version}_preexisting_remote.sql`),
      "-- stub for a version already in remote history\n",
    );
  }

  const migrationFile = join(migrations, `${version}_e2e_up.sql`);
  await writeFile(migrationFile, `create table if not exists e2e_up_${version} (id int);\n`);

  let targetError: unknown;
  const cleanupErrors: Array<unknown> = [];
  try {
    const applied = await cli(["migration", "up", "--db-url", project.dbUrl]);
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(applied.stderr, applied.stdout).toContain("Applying migration");

    const history = await queryLiveDb(
      project.dbUrl,
      "select version from supabase_migrations.schema_migrations where version = $1",
      [version],
    );
    expect(history).toHaveLength(1);

    const created = await queryLiveDb(project.dbUrl, "select to_regclass($1) as table_oid", [
      `public.e2e_up_${version}`,
    ]);
    expect(created[0]?.["table_oid"], "migration up must execute the migration sql").not.toBeNull();
  } catch (error) {
    targetError = error;
  } finally {
    try {
      await rm(migrationFile, { force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      const dropped = await cli([
        "db",
        "query",
        `drop table if exists e2e_up_${version}`,
        "--db-url",
        project.dbUrl,
      ]);
      requireLiveSuccess(dropped, "db query cleanup after migration up");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      const reverted = await cli([
        "migration",
        "repair",
        version,
        "--status",
        "reverted",
        "--db-url",
        project.dbUrl,
      ]);
      requireLiveSuccess(reverted, "migration repair cleanup after migration up");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwWithCleanup(targetError, cleanupErrors);
});
