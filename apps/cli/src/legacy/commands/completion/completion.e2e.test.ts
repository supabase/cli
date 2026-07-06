import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase completion (legacy)", () => {
  // Golden-path e2e for CLI-1858: `--no-descriptions` used to be rejected by
  // Effect's argv parser (`UnrecognizedOption`) before the request ever
  // reached the Go binary, because the flag wasn't declared on the TS leaf
  // command. Only a real subprocess run proves both halves of the fix: the
  // TS parser accepts the flag, and the Go binary actually receives it — it
  // switches the generated script's completion callback from `__complete` to
  // `__completeNoDesc` only when the flag is forwarded.
  test(
    "bash --no-descriptions is accepted and forwarded to the Go binary",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabase(["completion", "bash", "--no-descriptions"], {
        entrypoint: "legacy",
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("__completeNoDesc");
    },
  );
});
