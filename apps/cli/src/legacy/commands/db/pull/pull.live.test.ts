import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";

// `db pull` exits non-zero when the diff comes back empty (Go-identical, see
// IN_SYNC_SUGGESTION in pull.handler.ts), so the journey seeds a remote-only
// marker table through `db query` — no local migration and no history row.
// The marker cannot exist in the freshly provisioned shadow, so the diff is
// never empty regardless of engine and the pull deterministically writes it.
test("pulls the remote schema into an initial migration", async ({ cli, project, workspace }) => {
  const marker = `e2e_pull_${randomUUID().slice(0, 8)}`;
  const migrations = join(workspace.path, "supabase", "migrations");
  await mkdir(migrations, { recursive: true });
  const existingMigrations = new Set(await readdir(migrations));

  let targetError: unknown;
  const cleanupErrors: Array<unknown> = [];
  try {
    const seeded = await cli([
      "db",
      "query",
      `create table if not exists ${marker} (id int)`,
      "--db-url",
      project.dbUrl,
    ]);
    requireLiveSuccess(seeded, "db query setup for db pull");

    const result = await cli(["db", "pull", "--db-url", project.dbUrl, "--yes"]);
    expect(result.exitCode, result.stderr).toBe(0);

    expect(result.stderr, result.stderr).toContain("Schema written to");
    const generated = (await readdir(migrations)).filter((file) => !existingMigrations.has(file));
    expect(generated.length, result.stderr).toBeGreaterThan(0);
    const pulled = await Promise.all(
      generated.map((file) => readFile(join(migrations, file), "utf8")),
    );
    expect(pulled.join("\n"), result.stderr).toContain(marker);
  } catch (error) {
    targetError = error;
  } finally {
    // Remove the generated migration before resetting so the reset replays an
    // empty local set and restores the baseline schema, dropping the marker.
    let currentMigrations: ReadonlyArray<string> = [];
    try {
      currentMigrations = await readdir(migrations);
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const file of currentMigrations.filter(
      (candidate) => !existingMigrations.has(candidate),
    )) {
      try {
        await unlink(join(migrations, file));
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      const reset = await cli(["db", "reset", "--db-url", project.dbUrl, "--yes"]);
      requireLiveSuccess(reset, "db reset cleanup after db pull");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  throwWithCleanup(targetError, cleanupErrors);
});
