import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import {
  liveDatabaseTargetArgs,
  requireLiveSuccess,
  testLiveDestructiveDataPlane,
} from "../../../../../tests/helpers/live-context.ts";

testLiveDestructiveDataPlane(
  "pulls the remote schema after a local migration is applied",
  async ({ run, dbUrl, projectRef, workspace }) => {
    const version = `${Date.now()}${Math.floor(Math.random() * 10_000)
      .toString()
      .padStart(4, "0")}`;
    const migrations = join(workspace.path, "supabase", "migrations");
    await mkdir(migrations, { recursive: true });
    const migrationFile = join(migrations, `${version}_e2e_pull.sql`);
    await writeFile(migrationFile, `create table if not exists e2e_pull_${version} (id int);\n`);

    try {
      const pushed = await run([
        "db",
        "push",
        ...liveDatabaseTargetArgs(dbUrl, projectRef),
        "--yes",
      ]);
      requireLiveSuccess(pushed, "db push setup");

      const result = await run([
        "db",
        "pull",
        ...liveDatabaseTargetArgs(dbUrl, projectRef),
        "--yes",
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toMatch(
        /dial|no route|connection refused|could not connect|server closed the connection|i\/o timeout/i,
      );
    } finally {
      await unlink(migrationFile).catch(() => undefined);
      const reset = await run([
        "db",
        "reset",
        ...liveDatabaseTargetArgs(dbUrl, projectRef),
        "--yes",
      ]);
      requireLiveSuccess(reset, "db reset cleanup after db pull");
    }
  },
);
