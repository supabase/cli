import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { makeTempHome, runSupabase } from "../../../../../tests/helpers/cli.ts";

// Argument-validation negatives for `functions deploy`. This validation lives in
// the Go CLI today (the legacy TS command proxies to it); a black-box subprocess
// test keeps these assertions valid through the eventual native TS port — it
// guards behavior, not implementation. Asserting the SPECIFIC error text also
// avoids a false pass from an unrelated non-zero exit (e.g. a missing Go binary).
//
// All cases fail before any network call (cobra flag parsing / pre-resolution),
// so no auth or linked project is required.

const E2E_TIMEOUT_MS = 30_000;
const SLUG = "deploy-e2e-basic";
// Valid-format token + ref to clear the auth and project-ref gates (both checked
// before the Go bundler-flag validation under test). These cases all fail before
// any network call (cobra flag-group validation / the jobs check at the top of
// RunE), so neither value is ever used against a real API.
const FAKE_TOKEN = `sbp_${"0".repeat(40)}`;
const FAKE_REF = "a".repeat(20);

describe("supabase functions deploy (legacy) — argument validation", () => {
  const conflicts = [
    { name: "--use-api + --use-docker", flags: ["--use-api", "--use-docker"] },
    { name: "--use-api + --legacy-bundle", flags: ["--use-api", "--legacy-bundle"] },
    { name: "--use-docker + --legacy-bundle", flags: ["--use-docker", "--legacy-bundle"] },
  ] as const;

  for (const { name, flags } of conflicts) {
    test(`rejects ${name} as mutually exclusive`, { timeout: E2E_TIMEOUT_MS }, async () => {
      using home = makeTempHome();
      const { exitCode, stderr } = await runSupabase(
        ["functions", "deploy", SLUG, "--project-ref", FAKE_REF, ...flags],
        {
          entrypoint: "legacy",
          home: home.dir,
          env: { HOME: home.dir, SUPABASE_ACCESS_TOKEN: FAKE_TOKEN },
        },
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/none of the others can be|mutually exclusive/i);
    });
  }

  test("rejects --jobs without --use-api", { timeout: E2E_TIMEOUT_MS }, async () => {
    using home = makeTempHome();
    const { exitCode, stderr } = await runSupabase(
      ["functions", "deploy", SLUG, "--project-ref", FAKE_REF, "--use-docker", "--jobs", "2"],
      {
        entrypoint: "legacy",
        home: home.dir,
        env: { HOME: home.dir, SUPABASE_ACCESS_TOKEN: FAKE_TOKEN },
      },
    );
    expect(exitCode).not.toBe(0);
    // The Go CLI phrases this as either "must be used together with --use-api"
    // or "cannot be used with local bundling" depending on version — both mean
    // --jobs is rejected without server-side (--use-api) bundling.
    expect(stderr).toMatch(/--jobs\b.*(--use-api|local bundling)/i);
  });

  test("fails without a linked project or --project-ref", { timeout: E2E_TIMEOUT_MS }, async () => {
    using home = makeTempHome();
    const workdir = mkdtempSync(join(tmpdir(), "fn-deploy-nolink-"));
    try {
      const { exitCode, stderr } = await runSupabase(["functions", "deploy", SLUG], {
        entrypoint: "legacy",
        home: home.dir,
        cwd: workdir,
        env: { HOME: home.dir, SUPABASE_ACCESS_TOKEN: FAKE_TOKEN },
      });
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/Cannot find project ref|Have you run|supabase link/i);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
