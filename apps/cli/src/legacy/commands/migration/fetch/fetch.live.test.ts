import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import {
  describeLiveDataPlane,
  requireLiveProjectRef,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// `<timestamp>_<name>.sql` — Go's `MIGRATE_FILE_PATTERN`. Fetched files must
// match this so a later `migration list`/`up` can read them back.
const MIGRATION_FILE = /^(\d+)_.*\.sql$/u;

// Data-plane scenario (Postgres over the pooler) — see the note in
// `../list/list.live.test.ts`. `describeLiveDataPlane` runs this only when the
// project instance is ACTIVE_HEALTHY (the full stack with supabase-postgres-17);
// it SKIPS on the control-plane-only CI that omits it (CLI-1825).
//
// Round-trip: `migration fetch` reads the remote `schema_migrations` history and
// writes each row to `supabase/migrations/<version>_<name>.sql`; `migration list`
// then reads those same files back as the Local column. We run both in a throwaway
// project dir so the fetch writes nowhere near the repo, and the ref is supplied
// via SUPABASE_PROJECT_ID. A freshly provisioned project has no history yet, so
// the round-trip is exercised whether the remote has zero or many migrations.
describeLiveDataPlane("supabase migration fetch (live)", () => {
  test(
    "fetches remote history and lists it back (round-trip)",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const ref = requireLiveProjectRef();
      const projectDir = await mkdtemp(path.join(tmpdir(), "sb-migration-fetch-live-"));
      try {
        const fetched = await runSupabaseLive(["migration", "fetch"], {
          cwd: projectDir,
          env: { SUPABASE_PROJECT_ID: ref },
        });
        expect(`${fetched.stdout}${fetched.stderr}`).not.toContain("Unauthorized");
        expect(fetched.exitCode, `stdout:\n${fetched.stdout}\nstderr:\n${fetched.stderr}`).toBe(0);

        // fetch always creates supabase/migrations; every file it writes is a
        // well-formed migration filename.
        const migrationsDir = path.join(projectDir, "supabase", "migrations");
        const files = await readdir(migrationsDir);
        const versions = files
          .map((file) => MIGRATION_FILE.exec(file)?.[1])
          .filter((version): version is string => version !== undefined);
        expect(versions.length).toBe(files.length);

        // The same dir feeds `migration list` as the Local column — exit 0 and
        // every fetched version is reflected back.
        const listed = await runSupabaseLive(["migration", "list"], {
          cwd: projectDir,
          env: { SUPABASE_PROJECT_ID: ref },
        });
        expect(`${listed.stdout}${listed.stderr}`).not.toContain("Unauthorized");
        expect(listed.exitCode, `stdout:\n${listed.stdout}\nstderr:\n${listed.stderr}`).toBe(0);
        for (const version of versions) {
          expect(listed.stdout).toContain(version);
        }
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    },
  );
});
