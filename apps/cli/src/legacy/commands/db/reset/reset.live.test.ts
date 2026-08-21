import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import {
  liveDatabaseTargetArgs,
  requireLiveSuccess,
  test,
} from "../../../../../tests/helpers/live.ts";

test("resets the remote database with local migrations", async ({
  run,
  dbUrl,
  projectRef,
  workspace,
}) => {
  const version = `${Date.now()}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, "0")}`;
  const migrations = join(workspace.path, "supabase", "migrations");
  await mkdir(migrations, { recursive: true });
  const migrationFile = join(migrations, `${version}_e2e_reset.sql`);
  await writeFile(migrationFile, `create table if not exists e2e_reset_${version} (id int);\n`);

  try {
    const result = await run([
      "db",
      "reset",
      ...liveDatabaseTargetArgs(dbUrl, projectRef),
      "--yes",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Resetting remote database");
  } finally {
    await unlink(migrationFile).catch(() => undefined);
    const reset = await run(["db", "reset", ...liveDatabaseTargetArgs(dbUrl, projectRef), "--yes"]);
    requireLiveSuccess(reset, "db reset cleanup");
  }
});
