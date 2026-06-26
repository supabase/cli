import { expect, test } from "vitest";

import {
  describeLiveDb,
  requireLiveDbUrl,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 180_000;

// Data-plane scenario: `migration list` reads the remote migration history table
// over a direct Postgres connection via --db-url (not the Management API), so it
// is gated by `describeLiveDb` — it runs only when SUPABASE_LIVE_DB_URL is set
// (the cli-e2e-ci runner resolves the provisioned project's pooler URL). Skipped
// otherwise.
describeLiveDb("supabase migration list (live)", () => {
  test("lists remote migrations for the project", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const dbUrl = requireLiveDbUrl();
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "migration",
      "list",
      "--db-url",
      dbUrl,
    ]);
    expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
    // A freshly provisioned project may have no applied migrations; the command
    // still exits 0 and prints the (possibly empty) history table.
    expect(exitCode).toBe(0);
  });
});
