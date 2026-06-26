import { expect, test } from "vitest";

import {
  describeLiveDb,
  requireLiveDbUrl,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 180_000;

// Data-plane scenario: `db dump` connects to the project Postgres directly via
// --db-url (not the Management API), so it is gated by `describeLiveDb` — it
// runs only when SUPABASE_LIVE_DB_URL is set (the cli-e2e-ci runner resolves the
// provisioned project's pooler URL). Skipped otherwise.
describeLiveDb("supabase db dump (live)", () => {
  test("dumps the project schema to stdout", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const dbUrl = requireLiveDbUrl();
    const { exitCode, stdout, stderr } = await runSupabaseLive(["db", "dump", "--db-url", dbUrl]);
    expect(stderr).not.toContain("Unauthorized");
    expect(exitCode).toBe(0);
    // A real pg_dump of a Supabase project emits SQL DDL to stdout; assert it is
    // non-empty rather than pinning an exact header that varies by pg version.
    expect(stdout.trim().length).toBeGreaterThan(0);
  });
});
