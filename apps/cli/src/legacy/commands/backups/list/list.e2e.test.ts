import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase backups list (legacy)", () => {
  test("exposes the --project-ref flag through --help", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { stdout, exitCode } = await runSupabase(["backups", "list", "--help"], {
      entrypoint: "legacy",
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("--project-ref");
  });
});
