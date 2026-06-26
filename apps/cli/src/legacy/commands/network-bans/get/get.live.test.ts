import { expect, test } from "vitest";

import {
  describeLive,
  describeLiveProject,
  requireLiveProjectRef,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// Project-scoped read-only scenario. Skipped unless SUPABASE_LIVE_PROJECT_REF is
// set (the cli-e2e-ci runner provisions a project; a control-plane-only stack
// skips it). Reads the project's network bans via the Management API control
// plane — a fresh project has none, which is a valid empty list.
describeLiveProject("supabase network-bans get (live)", () => {
  test("gets network bans for the project", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const ref = requireLiveProjectRef();
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "network-bans",
      "get",
      "--project-ref",
      ref,
    ]);
    expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
    expect(exitCode).toBe(0);
  });

  test("emits network bans as machine-readable JSON", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const ref = requireLiveProjectRef();
    const { exitCode, stdout } = await runSupabaseLive([
      "network-bans",
      "get",
      "--project-ref",
      ref,
      "--output-format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    // Payload-only JSON shaped like { banned_ipv4_addresses: [...] }.
    const parsed = JSON.parse(stdout) as { banned_ipv4_addresses: string[] };
    expect(Array.isArray(parsed.banned_ipv4_addresses)).toBe(true);
  });
});

// Error path needing NO provisioned project: unknown --project-ref → 404 → exit
// non-zero, exercising the request path + error mapping on a control-plane stack.
describeLive("supabase network-bans get — unknown project (live)", () => {
  test("fails with a 404 for an unknown project ref", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "network-bans",
      "get",
      "--project-ref",
      "a".repeat(20),
    ]);
    const out = `${stdout}${stderr}`;
    expect(exitCode).not.toBe(0);
    expect(out).not.toContain("Unauthorized");
    expect(out).toContain("404");
  });
});
