import { expect, test } from "vitest";

import {
  describeLiveDataPlane,
  requireLiveProjectRef,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 180_000;

// Data-plane scenario: `db advisors --linked` runs lint queries against the
// project's *Postgres* (the cli mints a temp login role via the Management API),
// so it gates on `describeLiveDataPlane` — runs only when the project instance
// is ACTIVE_HEALTHY, otherwise SKIPS (e.g. the current cli-e2e-ci CI without
// supabase-postgres-17, CLI-1825). Activates once the data-plane is provisioned.
// The ref is supplied via SUPABASE_PROJECT_ID (db commands resolve the linked
// ref from env / config.toml / ref-file, not a `--project-ref` flag).
describeLiveDataPlane("supabase db advisors (live)", () => {
  test("emits advisor results as machine-readable JSON", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const ref = requireLiveProjectRef();
    // `--fail-on none` keeps the exit code 0 regardless of which advisories the
    // project happens to have, so the test asserts the command path, not the
    // project's current lint state.
    const { exitCode, stdout, stderr } = await runSupabaseLive(
      ["db", "advisors", "--linked", "--fail-on", "none", "--output-format", "json"],
      { env: { SUPABASE_PROJECT_ID: ref } },
    );
    expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
    expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
    // Payload-only JSON shaped like { results: [...] }.
    const parsed = JSON.parse(stdout) as { results: unknown[] };
    expect(Array.isArray(parsed.results)).toBe(true);
  });
});
