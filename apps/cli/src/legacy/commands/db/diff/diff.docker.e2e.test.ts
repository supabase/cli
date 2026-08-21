import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { describe } from "vitest";
import { requireCliSuccess, runSupabase } from "../../../../../tests/helpers/cli.ts";

const START_TIMEOUT_MS = 280_000;

// CLI-1947 regression: pg-delta's `filterPublicBuiltInDefaults()` unconditionally
// treated PUBLIC's implicit built-in privilege as a no-op on both sides of a diff,
// so a declarative schema's `REVOKE ... FROM PUBLIC` on a function was silently
// dropped from the generated migration — exit code 0, no error, just a missing
// statement. Fixed upstream in @supabase/pg-delta@1.0.0-alpha.33
// (supabase/pg-toolbelt#357). Verified directly against this repo's build: with
// the pre-fix pin (1.0.0-alpha.32) the migration below contains only the CREATE
// FUNCTION statement; the REVOKE is silently absent. This suite uses the local
// Docker-stack gate and never calls the Management API. See AGENTS.md's "Live
// tests" section.
describe("supabase db diff (live, pg-delta declarative privileges)", () => {
  let projectDir: string | undefined;

  afterEach(async () => {
    if (projectDir === undefined) return;
    // Best-effort cleanup even if an assertion above failed mid-lifecycle — a
    // leaked local stack would otherwise pollute the CI runner for later jobs.
    await runSupabase(["stop", "--no-backup"], { cwd: projectDir }).catch(() => undefined);
    await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
    projectDir = undefined;
  });

  test(
    "keeps REVOKE ... FROM PUBLIC on a function when diffing a declarative schema against local",
    { timeout: START_TIMEOUT_MS },
    async () => {
      projectDir = await mkdtemp(path.join(tmpdir(), "sb-db-diff-live-"));

      const init = await runSupabase(["init"], { cwd: projectDir });
      requireCliSuccess(init, "init setup");

      // Exclude the heaviest, least relevant services — `db diff` only needs the
      // local Postgres container reachable, same rationale as stop/status.
      const start = await runSupabase(
        ["start", "--exclude", "studio", "--exclude", "analytics", "--exclude", "vector"],
        { cwd: projectDir, exitTimeoutMs: START_TIMEOUT_MS },
      );
      requireCliSuccess(start, "start setup");

      // Minimal, deterministic repro: execute a fresh function's implicit PUBLIC
      // EXECUTE grant, explicitly revoked, directly against the local database.
      // `db query` is setup only; the command under test remains `db diff`.
      const query = await runSupabase(
        [
          "db",
          "query",
          `create function public.probe_fn()
returns void
language sql
as $$ select 1; $$;

revoke execute on function public.probe_fn() from public;`,
          "--local",
        ],
        { cwd: projectDir, exitTimeoutMs: START_TIMEOUT_MS },
      );
      requireCliSuccess(query, "db query setup");

      const diff = await runSupabase(
        ["db", "diff", "--local", "--use-pg-delta", "-f", "revoke_public_execute"],
        { cwd: projectDir, exitTimeoutMs: START_TIMEOUT_MS },
      );
      expect(diff.exitCode, `stdout:\n${diff.stdout}\nstderr:\n${diff.stderr}`).toBe(0);

      const migrationsDir = path.join(projectDir, "supabase", "migrations");
      const written =
        existsSync(migrationsDir) &&
        readdirSync(migrationsDir).find((f) => f.endsWith("_revoke_public_execute.sql"));
      expect(written, `no migration written; stderr:\n${diff.stderr}`).toBeTruthy();
      const sql = readFileSync(path.join(migrationsDir, written as string), "utf8");

      // The negative-space regression: pre-fix, exit code 0 and this file would
      // exist, but silently missing the REVOKE statement (only the CREATE FUNCTION
      // survives). Anchor the match to the function's own REVOKE statement — up to
      // its terminating `;` — so this cannot pass on an unrelated PUBLIC mention
      // elsewhere in the file.
      expect(sql).toContain("CREATE FUNCTION public.probe_fn()");
      expect(sql).toMatch(
        /REVOKE\s+(?:ALL|EXECUTE)\s+ON\s+FUNCTION\s+public\.probe_fn\(\)\s+FROM\s+[^;]*PUBLIC[^;]*;/i,
      );
    },
  );
});
