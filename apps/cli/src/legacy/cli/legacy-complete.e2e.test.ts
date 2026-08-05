import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase __complete (legacy)", () => {
  test(
    "migration li completes to list with a description and the NoFileComp directive",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabase(["__complete", "migration", "li"], {
        entrypoint: "legacy",
      });
      expect(exitCode).toBe(0);
      const lines = stdout.trim().split("\n");
      expect(lines[0]).toBe("list\tList local and remote migrations");
      expect(lines.at(-1)).toBe(":4");
    },
  );

  test(
    "__completeNoDesc strips the description from the same candidate",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabase(["__completeNoDesc", "migration", "li"], {
        entrypoint: "legacy",
      });
      expect(exitCode).toBe(0);
      const lines = stdout.trim().split("\n");
      expect(lines[0]).toBe("list");
      expect(lines.at(-1)).toBe(":4");
    },
  );

  test("root-level flag-name completion offers --debug", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { exitCode, stdout } = await runSupabase(["__complete", "--d"], {
      entrypoint: "legacy",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--debug\tOutput debug logs to stderr.");
  });
});
