import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase completion", () => {
  // Only a real subprocess run proves the argv parser accepts --no-descriptions and the
  // handler selects the no-desc template variant.
  test(
    "bash --no-descriptions is accepted and produces the native no-descriptions script",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabase(
        ["completion", "bash", "--no-descriptions"],
        {},
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("__completeNoDesc");
    },
  );

  // Smoke-tests the default code path end-to-end for a shell other than bash.
  test(
    "zsh with no flags produces the native default script",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabase(["completion", "zsh"], {});
      expect(exitCode).toBe(0);
      expect(stdout).toContain("#compdef supabase");
      expect(stdout).toContain("__complete");
    },
  );
});
