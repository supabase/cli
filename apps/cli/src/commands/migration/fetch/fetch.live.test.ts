import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

const NAME = "cli_live_fetch";

function liveMigrationVersion(): string {
  return new Date().toISOString().replace(/\D/gu, "").slice(0, 14);
}

// Destructive: repairs remote migration history in setup and reverts that row in
// teardown.
//
// `fetch` has no undefined-table fallback (unlike `list`), so it fails against a fresh
// project with no schema_migrations table. The setup seeds one row via
// `migration repair --status applied` first, which creates the table. The pooler URL
// is passed explicitly to avoid falling back to a direct IPv6 host.
test(
  "fetches a seeded remote migration into the local migrations directory",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ cli, project }) => {
    const targetArgs = ["--db-url", project.dbUrl];
    const version = liveMigrationVersion();
    const migrationFile = `${version}_${NAME}.sql`;
    const seedDir = await mkdtemp(path.join(tmpdir(), "sb-migration-seed-live-"));
    const fetchDir = await mkdtemp(path.join(tmpdir(), "sb-migration-fetch-live-"));
    let targetError: unknown;
    const cleanupErrors: Array<unknown> = [];
    try {
      // repair --status applied reads the local file for name/statements, so write it
      // before running repair.
      await mkdir(path.join(seedDir, "supabase", "migrations"), { recursive: true });
      await writeFile(
        path.join(seedDir, "supabase", "migrations", migrationFile),
        "create table if not exists public.cli_live_roundtrip (id int);\n",
      );
      const repairResult = await cli(
        ["migration", "repair", version, "--status", "applied", ...targetArgs],
        { cwd: seedDir },
      );
      requireLiveSuccess(repairResult, "migration repair setup");

      // A fresh, empty dir avoids the overwrite prompt.
      const fetched = await cli(["migration", "fetch", ...targetArgs], { cwd: fetchDir });
      expect(fetched.exitCode, `stdout:\n${fetched.stdout}\nstderr:\n${fetched.stderr}`).toBe(0);

      const files = await readdir(path.join(fetchDir, "supabase", "migrations"));
      expect(files).toContain(migrationFile);
    } catch (error) {
      targetError = error;
    } finally {
      try {
        const reverted = await cli(
          ["migration", "repair", version, "--status", "reverted", ...targetArgs],
          { cwd: seedDir },
        );
        if (
          reverted.exitCode !== 0 &&
          !/not found|does not exist/i.test(`${reverted.stdout}\n${reverted.stderr}`)
        ) {
          cleanupErrors.push(
            new Error(`migration repair cleanup failed:\n${reverted.stdout}\n${reverted.stderr}`),
          );
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      await rm(seedDir, { recursive: true, force: true }).catch((error) =>
        cleanupErrors.push(error),
      );
      await rm(fetchDir, { recursive: true, force: true }).catch((error) =>
        cleanupErrors.push(error),
      );
    }
    throwWithCleanup(targetError, cleanupErrors);
  },
);
