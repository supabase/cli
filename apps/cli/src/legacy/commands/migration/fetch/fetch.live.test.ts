import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// A uniquely named migration to seed into the remote history and fetch back.
const NAME = "cli_live_fetch";

function liveMigrationVersion(): string {
  return new Date().toISOString().replace(/\D/gu, "").slice(0, 14);
}

// Destructive data-plane scenario (Postgres over the pooler) — the setup repairs
// remote migration history and the teardown reverts that exact row. The fixture
// provisions one ACTIVE_HEALTHY project for the serial live suite.
//
// Golden path: `migration fetch` reads the remote `schema_migrations` history and
// writes each row to `supabase/migrations/<version>_<name>.sql`.
//
// Unlike `migration list`, `migration fetch` does NOT tolerate a missing history
// table: reading the migration table has no undefined-table fallback (only
// the list path does), so against a freshly provisioned
// project with no `supabase_migrations.schema_migrations` table it exits non-zero
// (`relation … does not exist`). So we first SEED one migration into the remote
// history via `migration repair --status applied` (which creates the migration
// table then upserts the version from the local file), establishing
// the table + a row for `fetch` to read back. The shared fixture's pooler URL is
// passed explicitly so the test does not fall back to a direct IPv6 host.
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
      // Seed: record one migration in the remote history. `repair --status applied`
      // reads the local file for the version's name/statements, so write it first.
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

      // Fetch into a fresh (empty) dir so no overwrite prompt fires; it reads the
      // remote history and writes <version>_<name>.sql.
      const fetched = await cli(["migration", "fetch", ...targetArgs], { cwd: fetchDir });
      expect(fetched.exitCode, `stdout:\n${fetched.stdout}\nstderr:\n${fetched.stderr}`).toBe(0);

      // fetch wrote the seeded migration back, under its established filename format.
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
