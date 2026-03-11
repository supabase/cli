import { describe, expect, test } from "vitest";
import { runSupabase } from "../../tests/helpers/cli.ts";

describe("--usage", () => {
  test("outputs usage spec for the full CLI", async () => {
    const { stdout, exitCode } = await runSupabase(["--usage"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('bin "supabase"');
    expect(stdout).toContain('cmd "login"');
    expect(stdout).toContain("flag");
  });

  test("outputs usage spec even from a subcommand position", async () => {
    const { stdout, exitCode } = await runSupabase(["login", "--usage"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('bin "supabase"');
  });

  test("includes version in the spec", async () => {
    const { stdout, exitCode } = await runSupabase(["--usage"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("version");
  });
});
