import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import {
  describeLiveDataPlane,
  requireLiveProjectRef,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// A deterministic migration to seed into the remote history and fetch back.
const VERSION = "20240101000000";
const NAME = "cli_live_roundtrip";
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;

// Data-plane scenario (Postgres over the pooler) — see the note in
// `../list/list.live.test.ts`. `describeLiveDataPlane` runs this only when the
// project instance is ACTIVE_HEALTHY (the full stack with supabase-postgres-17);
// it SKIPS on the control-plane-only CI that omits it (CLI-1825).
//
// Round-trip: `migration fetch` reads the remote `schema_migrations` history and
// writes each row to `supabase/migrations/<version>_<name>.sql`; `migration list`
// then reads those files back as the Local column.
//
// Unlike `migration list`, `migration fetch` does NOT tolerate a missing history
// table: Go's `ReadMigrationTable` has no `pgerrcode.UndefinedTable` fallback (only
// the list path does — `pkg/migration/list.go`), so against a freshly provisioned
// project with no `supabase_migrations.schema_migrations` table it exits non-zero
// (`relation … does not exist`). So we first SEED one migration into the remote
// history via `migration repair --status applied` (Go's `repair` runs
// `CreateMigrationTable` then upserts the version from the local file), establishing
// the table + a row for `fetch` to read back. The ref is supplied via
// SUPABASE_PROJECT_ID. The seed is idempotent (upsert) and the supabox stack is torn
// down per run, so it leaves no shared state behind.
describeLiveDataPlane("supabase migration fetch (live)", () => {
  test(
    "seeds remote history, fetches it back, and lists it (round-trip)",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const ref = requireLiveProjectRef();
      const seedDir = await mkdtemp(path.join(tmpdir(), "sb-migration-seed-live-"));
      const fetchDir = await mkdtemp(path.join(tmpdir(), "sb-migration-fetch-live-"));
      try {
        // Seed: record one migration in the remote history. `repair --status applied`
        // reads the local file for the version's name/statements, so write it first.
        await mkdir(path.join(seedDir, "supabase", "migrations"), { recursive: true });
        await writeFile(
          path.join(seedDir, "supabase", "migrations", MIGRATION_FILE),
          "create table if not exists public.cli_live_roundtrip (id int);\n",
        );
        const repaired = await runSupabaseLive(
          ["migration", "repair", VERSION, "--status", "applied"],
          { cwd: seedDir, env: { SUPABASE_PROJECT_ID: ref } },
        );
        expect(`${repaired.stdout}${repaired.stderr}`).not.toContain("Unauthorized");
        expect(repaired.exitCode, `stdout:\n${repaired.stdout}\nstderr:\n${repaired.stderr}`).toBe(
          0,
        );

        // Fetch into a fresh (empty) dir so no overwrite prompt fires; it reads the
        // remote history and writes <version>_<name>.sql.
        const fetched = await runSupabaseLive(["migration", "fetch"], {
          cwd: fetchDir,
          env: { SUPABASE_PROJECT_ID: ref },
        });
        expect(`${fetched.stdout}${fetched.stderr}`).not.toContain("Unauthorized");
        expect(fetched.exitCode, `stdout:\n${fetched.stdout}\nstderr:\n${fetched.stderr}`).toBe(0);

        // fetch wrote the seeded migration back, under its Go-compatible filename.
        const files = await readdir(path.join(fetchDir, "supabase", "migrations"));
        expect(files).toContain(MIGRATION_FILE);

        // The same dir feeds `migration list` as the Local column — exit 0 and the
        // fetched version is reflected back.
        const listed = await runSupabaseLive(["migration", "list"], {
          cwd: fetchDir,
          env: { SUPABASE_PROJECT_ID: ref },
        });
        expect(`${listed.stdout}${listed.stderr}`).not.toContain("Unauthorized");
        expect(listed.exitCode, `stdout:\n${listed.stdout}\nstderr:\n${listed.stderr}`).toBe(0);
        expect(listed.stdout).toContain(VERSION);
      } finally {
        await rm(seedDir, { recursive: true, force: true });
        await rm(fetchDir, { recursive: true, force: true });
      }
    },
  );
});
