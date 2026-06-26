import { expect, test } from "vitest";

import {
  describeLiveDb,
  requireLiveDbUrl,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 180_000;

// Data-plane scenario: `db advisors` runs lint queries against the project
// Postgres via --db-url, so it is gated by `describeLiveDb` — it runs only when
// SUPABASE_LIVE_DB_URL is set (the cli-e2e-ci runner resolves the provisioned
// project's pooler URL). Skipped otherwise.
describeLiveDb("supabase db advisors (live)", () => {
  test("emits advisor results as machine-readable JSON", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const dbUrl = requireLiveDbUrl();
    // `--fail-on none` keeps the exit code 0 regardless of which advisories the
    // project happens to have, so the test asserts the command path, not the
    // project's current lint state.
    const { exitCode, stdout } = await runSupabaseLive([
      "db",
      "advisors",
      "--db-url",
      dbUrl,
      "--fail-on",
      "none",
      "--output-format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    // Payload-only JSON shaped like { results: [...] }.
    const parsed = JSON.parse(stdout) as { results: unknown[] };
    expect(Array.isArray(parsed.results)).toBe(true);
  });
});
