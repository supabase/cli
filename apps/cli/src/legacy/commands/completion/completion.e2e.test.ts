import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase completion (legacy)", () => {
  // Golden-path e2e for CLI-1858 / CLI-1965: `--no-descriptions` used to be
  // rejected by Effect's argv parser (`UnrecognizedOption`) before the flag
  // reached the completion command at all. As of CLI-1965 the script is
  // generated natively in TS (no Go binary involved) — only a real
  // subprocess run proves the TS parser accepts the flag AND that the
  // handler actually selects the no-desc variant of the native template.
  test(
    "bash --no-descriptions is accepted and produces the native no-descriptions script",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabase(["completion", "bash", "--no-descriptions"], {
        entrypoint: "legacy",
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("__completeNoDesc");
    },
  );

  // Minimal cross-shell smoke coverage: proves the default (with-descriptions)
  // code path also works end-to-end through a real subprocess, for a shell
  // other than bash.
  test(
    "zsh with no flags produces the native default script",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabase(["completion", "zsh"], {
        entrypoint: "legacy",
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("#compdef supabase");
      expect(stdout).toContain("__complete");
    },
  );
});
