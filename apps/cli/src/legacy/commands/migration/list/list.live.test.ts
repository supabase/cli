import { expect, test } from "vitest";

import {
  describeLiveProject,
  requireLiveProjectRef,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// Project-scoped scenario, skipped unless SUPABASE_LIVE_PROJECT_REF is set (the
// cli-e2e-ci runner provisions a project and exports it).
//
// Unlike `functions`/`branches` list (Management-API reads), `migration list`
// connects to the project's *Postgres* over the pooler — the data-plane. That
// only works on the Linux CI runner, where the project reaches ACTIVE_HEALTHY
// and `*.supabase.red` is routable (see cli-e2e-ci README + CLI-1834). The
// `--linked` default mints a temp login role via the Management API, then reads
// `supabase_migrations.schema_migrations`. On a freshly provisioned project the
// history table is absent, which the handler maps to an empty list (Go's
// `pgerrcode.UndefinedTable`), so the command still exits 0.
//
// The ref is supplied via SUPABASE_PROJECT_ID (migration commands resolve the
// linked ref from env/config.toml/ref-file, not a `--project-ref` flag).
describeLiveProject("supabase migration list (live)", () => {
  test(
    "lists migrations on the linked project's database",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const ref = requireLiveProjectRef();
      const { exitCode, stdout, stderr } = await runSupabaseLive(["migration", "list"], {
        env: { SUPABASE_PROJECT_ID: ref },
      });
      expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
      expect(exitCode).toBe(0);
    },
  );

  test(
    "emits machine-readable JSON with --output-format json",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const ref = requireLiveProjectRef();
      const { exitCode, stdout } = await runSupabaseLive(
        ["migration", "list", "--output-format", "json"],
        { env: { SUPABASE_PROJECT_ID: ref } },
      );
      expect(exitCode).toBe(0);
      // stdout must be payload-only valid JSON in json mode (no spinner/log noise).
      expect(() => JSON.parse(stdout)).not.toThrow();
    },
  );
});
