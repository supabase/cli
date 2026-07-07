import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { makeTempHome, runSupabase } from "../../../../../tests/helpers/cli.ts";

// Argument-validation negatives for `functions deploy`. Both checks below are
// native TS today (deployFunctions in shared/functions/deploy.ts) — the
// bundler-mutex message byte-matches cobra's validateExclusiveFlagGroups
// template, and --jobs mirrors Go's own top-of-RunE guard (`if useApi { ... }
// else if maxJobs > 1 { error }`). A black-box subprocess test still earns its
// keep here: asserting the SPECIFIC error text avoids a false pass from an
// unrelated non-zero exit (e.g. a missing build artifact), and exercises the
// real CLI entrypoint end to end.
//
// All cases fail before any network call (flag-group validation / the jobs
// check both run before project-ref resolution), so no auth or linked
// project is required.

const E2E_TIMEOUT_MS = 30_000;
const SLUG = "deploy-e2e-basic";
// Valid-format token + ref to clear the auth and project-ref gates (both checked
// before the bundler-flag validation under test). These cases all fail before
// any network call (flag-group validation / the jobs check at the top of the
// handler), so neither value is ever used against a real API.
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
      // Byte-matches cobra's validateExclusiveFlagGroups (flag_groups.go:204).
      expect(stderr).toContain(
        "if any flags in the group [use-api use-docker legacy-bundle] are set none of the others can be",
      );
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
    expect(stderr).toContain("--jobs must be used together with --use-api");
  });

  test(
    "rejects --jobs without --use-api even with --use-docker=false (Go parity gap)",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const { exitCode, stderr } = await runSupabase(
        [
          "functions",
          "deploy",
          SLUG,
          "--project-ref",
          FAKE_REF,
          "--use-docker=false",
          "--jobs",
          "2",
        ],
        {
          entrypoint: "legacy",
          home: home.dir,
          env: { HOME: home.dir, SUPABASE_ACCESS_TOKEN: FAKE_TOKEN },
        },
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("--jobs must be used together with --use-api");
    },
  );

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
