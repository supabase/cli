import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import {
  describeLiveDataPlane,
  requireLiveProjectRef,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 300_000;

// A fresh, isolated temp workdir so the CLI writes migrations there and never
// touches the repo tree. The provisioned project ref is supplied to `--linked` via
// the `SUPABASE_PROJECT_ID` env var — that is the `--linked` resolver chain in both
// Go and the legacy port (flag → `SUPABASE_PROJECT_ID` → `supabase/.temp/project-ref`);
// `config.toml`'s `project_id` is NOT consulted for `--linked`.
function tempWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "sb-db-pull-live-"));
}

// Data-plane: needs a provisioned project whose database is routable (the
// cli-e2e-ci Linux runner). `describeLiveDataPlane` runs this only when the project
// instance is ACTIVE_HEALTHY, so a control-plane-only stack (ref set but the DB
// unreachable, e.g. local macOS or the current cli-e2e-ci control-plane case) is
// skipped rather than timing out on the pg_dump seed.
describeLiveDataPlane("supabase db pull (live)", () => {
  test(
    "initial pull from the linked project (native pg_dump seed + migra diff)",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const ref = requireLiveProjectRef();
      const dir = tempWorkdir();
      try {
        const { stdout, stderr, exitCode } = await runSupabaseLive(["db", "pull", "--linked"], {
          cwd: dir,
          env: { SUPABASE_PROJECT_ID: ref },
          exitTimeoutMs: LIVE_TIMEOUT_MS - 20_000,
          // Decline the "Update remote migration history table?" prompt with a piped
          // `n`: this project ref is shared across live runs, and writing a
          // `schema_migrations` row here would make a later run see it as an extra
          // remote migration and fail with a history conflict before pulling. The
          // piped answer also exercises the native prompt's stdin scanning end to end.
          stdin: "n\n",
        });
        const combined = `${stdout}${stderr}`;
        expect(combined).not.toContain("Unauthorized");
        // No local migrations → the native initial-migra path runs: pg_dump the remote
        // schema, then append the migra diff. Assert on the durable side effect: a
        // provisioned project with schema writes a `<timestamp>_remote_schema.sql`
        // migration; a fresh empty schema reports "No schema changes found". Either
        // proves the path ran end to end against the real database without hanging.
        const migDir = join(dir, "supabase", "migrations");
        const wroteMigration =
          existsSync(migDir) && readdirSync(migDir).some((f) => f.endsWith("_remote_schema.sql"));
        expect(wroteMigration || combined.includes("No schema changes found")).toBe(true);
        // The native path creates the migration file BEFORE pg_dump runs, so a failed
        // dump/diff could leave a stray file behind — a written migration is only
        // meaningful if the command actually succeeded.
        if (wroteMigration) {
          expect(exitCode).toBe(0);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
