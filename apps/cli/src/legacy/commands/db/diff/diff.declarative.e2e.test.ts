import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { describe } from "vitest";
import {
  makeTempLegacyStackProject,
  overrideStackPorts,
  requireCliSuccess,
  runSupabase,
} from "../../../../../tests/helpers/cli.ts";

const CLI_COMMAND_TIMEOUT_MS = 60_000;
const STACK_START_TIMEOUT_MS = 280_000;
const DIFF_COMMAND_TIMEOUT_MS = 280_000;
const CLEANUP_TIMEOUT_MS = 120_000;
const LIFECYCLE_MARGIN_MS = 30_000;
const CLEANUP_HOOK_TIMEOUT_MS = CLEANUP_TIMEOUT_MS + LIFECYCLE_MARGIN_MS;
const DIFF_TEST_TIMEOUT_MS =
  CLI_COMMAND_TIMEOUT_MS +
  STACK_START_TIMEOUT_MS +
  CLI_COMMAND_TIMEOUT_MS * 2 +
  DIFF_COMMAND_TIMEOUT_MS +
  LIFECYCLE_MARGIN_MS;

// CLI-1947 regression: pg-delta's `filterPublicBuiltInDefaults()` unconditionally
// treated PUBLIC's implicit built-in privilege as a no-op on both sides of a diff,
// so a declarative schema's `REVOKE ... FROM PUBLIC` on a function was silently
// dropped from the generated migration — exit code 0, no error, just a missing
// statement. Fixed upstream in @supabase/pg-delta@1.0.0-alpha.33
// (supabase/pg-toolbelt#357). Verified directly against this repo's build: with
// the pre-fix pin (1.0.0-alpha.32) the migration below contains only the CREATE
// FUNCTION statement; the REVOKE is silently absent. This suite uses the local
// Docker-stack e2e coverage and never calls the Management API. See AGENTS.md's
// "E2e tests" section.
describe("supabase db diff (e2e, pg-delta declarative privileges)", () => {
  let project: Awaited<ReturnType<typeof makeTempLegacyStackProject>> | undefined;

  afterEach(async () => {
    await project?.cleanup().catch(() => undefined);
    project = undefined;
  }, CLEANUP_HOOK_TIMEOUT_MS);

  test(
    "keeps REVOKE ... FROM PUBLIC on a function when diffing a declarative schema against local",
    { timeout: DIFF_TEST_TIMEOUT_MS },
    async () => {
      project = await makeTempLegacyStackProject("sb-db-diff-e2e-");
      const projectDir = project.dir;

      const init = await runSupabase(["init"], {
        entrypoint: "legacy",
        cwd: projectDir,
        exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS,
      });
      requireCliSuccess(init, "init setup");
      await overrideStackPorts(projectDir);

      // Exclude the heaviest, least relevant services — `db diff` only needs the
      // local Postgres container reachable, same rationale as stop/status.
      const start = await runSupabase(
        ["start", "--exclude", "studio", "--exclude", "logflare", "--exclude", "vector"],
        { entrypoint: "legacy", cwd: projectDir, exitTimeoutMs: STACK_START_TIMEOUT_MS },
      );
      requireCliSuccess(start, "start setup");

      // Minimal, deterministic repro: execute a fresh function's implicit PUBLIC
      // EXECUTE grant, explicitly revoked, directly against the local database.
      // `db query` is setup only; keep each statement in its own invocation
      // because the legacy query command sends one prepared statement at a time.
      const createFunction = await runSupabase(
        [
          "db",
          "query",
          `create function public.probe_fn()
returns void
language sql
as $$ select 1; $$;`,
          "--local",
        ],
        { entrypoint: "legacy", cwd: projectDir, exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS },
      );
      requireCliSuccess(createFunction, "db query create-function setup");

      const revoke = await runSupabase(
        ["db", "query", "revoke execute on function public.probe_fn() from public;", "--local"],
        { entrypoint: "legacy", cwd: projectDir, exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS },
      );
      requireCliSuccess(revoke, "db query revoke setup");

      const diff = await runSupabase(
        ["db", "diff", "--local", "--use-pg-delta", "-f", "revoke_public_execute"],
        { entrypoint: "legacy", cwd: projectDir, exitTimeoutMs: DIFF_COMMAND_TIMEOUT_MS },
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
      expect(sql).toMatch(
        /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+"?public"?\s*\.\s*"?probe_fn"?\s*\(\)/i,
      );
      expect(sql).toMatch(
        /REVOKE\s+(?:ALL|EXECUTE)\s+ON\s+FUNCTION\s+"?public"?\s*\.\s*"?probe_fn"?\s*\(\)\s+FROM\s+[^;]*PUBLIC[^;]*;/i,
      );
    },
  );
});
