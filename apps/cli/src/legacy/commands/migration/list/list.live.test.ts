import { expect, test } from "vitest";

import {
  describeLiveDataPlane,
  requireLiveProjectRef,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// Data-plane scenario: unlike `functions`/`branches` list (Management-API
// reads), `migration list` connects to the project's *Postgres* over the pooler.
// `describeLiveDataPlane` runs this only when the project instance is
// ACTIVE_HEALTHY — i.e. the full stack with supabase-postgres-17. The current
// cli-e2e-ci CI omits it (CLI-1825), so the project record exists but its DB is
// unreachable, and this suite SKIPS there rather than failing (see the gate's
// note). It activates automatically once the data-plane is provisioned.
//
// The `--linked` default mints a temp login role via the Management API, then
// reads `supabase_migrations.schema_migrations`. On a freshly provisioned
// project the history table is absent, which the handler maps to an empty list
// (Go's `pgerrcode.UndefinedTable`), so the command still exits 0. The ref is
// supplied via SUPABASE_PROJECT_ID (migration commands resolve the linked ref
// from env / config.toml / ref-file, not a `--project-ref` flag).
describeLiveDataPlane("supabase migration list (live)", () => {
  test(
    "lists migrations on the linked project's database",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const ref = requireLiveProjectRef();
      const { exitCode, stdout, stderr } = await runSupabaseLive(["migration", "list"], {
        env: { SUPABASE_PROJECT_ID: ref },
      });
      expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
      expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
    },
  );

  test(
    "emits machine-readable JSON with --output-format json",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const ref = requireLiveProjectRef();
      const { exitCode, stdout, stderr } = await runSupabaseLive(
        ["migration", "list", "--output-format", "json"],
        { env: { SUPABASE_PROJECT_ID: ref } },
      );
      expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
      // stdout must be payload-only valid JSON in json mode (no spinner/log noise).
      expect(() => JSON.parse(stdout)).not.toThrow();
    },
  );
});
