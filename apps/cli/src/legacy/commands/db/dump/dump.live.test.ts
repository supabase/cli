import { expect, test } from "vitest";

import {
  describeLiveDataPlane,
  requireLiveProjectRef,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 180_000;

// Data-plane scenario: `db dump --linked` connects to the project's *Postgres*
// (the cli mints a temp login role via the Management API), so it gates on
// `describeLiveDataPlane` — runs only when the project instance is
// ACTIVE_HEALTHY, otherwise SKIPS (e.g. the current cli-e2e-ci CI without
// supabase-postgres-17, CLI-1825). Activates once the data-plane is provisioned.
// The ref is supplied via SUPABASE_PROJECT_ID (db commands resolve the linked
// ref from env / config.toml / ref-file, not a `--project-ref` flag).
describeLiveDataPlane("supabase db dump (live)", () => {
  test("dumps the linked project schema to stdout", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const ref = requireLiveProjectRef();
    const { exitCode, stdout, stderr } = await runSupabaseLive(["db", "dump", "--linked"], {
      env: { SUPABASE_PROJECT_ID: ref },
    });
    expect(stderr).not.toContain("Unauthorized");
    expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
    // A real pg_dump of a Supabase project emits SQL DDL to stdout; assert it is
    // non-empty rather than pinning an exact header that varies by pg version.
    expect(stdout.trim().length).toBeGreaterThan(0);
  });
});
