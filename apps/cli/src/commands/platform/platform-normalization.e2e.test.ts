import { describe, expect, test } from "vitest";

import { runSupabase } from "../../../tests/helpers/cli.ts";

describe("platform command normalization", () => {
  test("shows the normalized oauth authorize command", async () => {
    const { stdout, exitCode } = await runSupabase(["platform", "oauth", "authorize", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("supabase platform oauth authorize");
    expect(stdout).not.toContain("authorize authorize");
  });

  test("shows the normalized branches diff command", async () => {
    const { stdout, exitCode } = await runSupabase(["platform", "branches", "diff", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("supabase platform branches diff");
    expect(stdout).not.toContain("diff diff");
  });

  test("accepts string-only union params in dry-run mode", async () => {
    const { stdout, exitCode } = await runSupabase([
      "platform",
      "branches",
      "delete",
      "--params",
      '{"branch_id_or_ref":"foo"}',
      "--dry-run",
      "--output-format",
      "json",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('"dryRun":true');
    expect(stdout).toContain('"branch_id_or_ref":"foo"');
  });

  test("accepts flattened enum params in dry-run mode", async () => {
    const { stdout, exitCode } = await runSupabase([
      "platform",
      "projects",
      "billing",
      "addons",
      "remove",
      "--params",
      '{"ref":"abcdefghijklmnopqrst","addon_variant":"cd_default"}',
      "--dry-run",
      "--output-format",
      "json",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('"dryRun":true');
    expect(stdout).toContain('"addon_variant":"cd_default"');
  });

  test("supports urlencoded bodies in dry-run mode", async () => {
    const { stdout, exitCode } = await runSupabase([
      "platform",
      "oauth",
      "token",
      "exchange",
      "--body",
      "grant_type=refresh_token&refresh_token=refresh-token",
      "--dry-run",
      "--output-format",
      "json",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('"dryRun":true');
    expect(stdout).toContain('"bodyKind":"urlencoded"');
    expect(stdout).toContain('"grant_type":"refresh_token"');
  });
});
