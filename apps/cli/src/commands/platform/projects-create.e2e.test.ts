import { describe, expect, test } from "vitest";

import { runSupabase } from "../../../tests/helpers/cli.ts";

describe("supabase platform projects create", () => {
  test("shows generated help output", async () => {
    const { stdout, exitCode } = await runSupabase(["platform", "projects", "create", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("supabase platform projects create");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("--fields");
  });

  test("supports inline --json with --dry-run", async () => {
    const { stdout, exitCode } = await runSupabase([
      "platform",
      "projects",
      "create",
      "--json",
      '{"name":"from-inline","db_pass":"super-secret","organization_slug":"my-org"}',
      "--dry-run",
      "--output-format",
      "json",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('"dryRun":true');
    expect(stdout).toContain('"name":"from-inline"');
    expect(stdout).toContain('"<redacted>"');
  });

  test("supports --json - with --dry-run", async () => {
    const { stdout, exitCode } = await runSupabase(
      ["platform", "projects", "create", "--json", "-", "--dry-run", "--output-format", "json"],
      {
        stdin: JSON.stringify({
          name: "from-stdin",
          db_pass: "stdin-secret",
          organization_slug: "my-org",
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('"name":"from-stdin"');
    expect(stdout).toContain('"<redacted>"');
  });

  test("returns structured json errors in non-interactive mode", async () => {
    const { stdout, exitCode } = await runSupabase([
      "platform",
      "projects",
      "create",
      "--output-format",
      "json",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('"code":"NonInteractiveError"');
    expect(stdout).toContain("Provide all required values");
  });
});
