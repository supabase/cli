import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const TEST_PROJECT_REF = "abcdefghijklmnopqrst";
const TEST_TOKEN = "sbp_" + "a".repeat(40);

describe("supabase snippets (legacy)", () => {
  // Golden-path e2e: exercises the real subprocess boundary for the only
  // API-free code path in `snippets download` — the UUID pre-check in
  // `download.handler.ts`. This validates that the compiled-binary wiring
  // (Command.provide, runtime layer, withJsonErrorHandling) correctly
  // surfaces the Go-format `invalid snippet ID:` prefix to stdout/stderr
  // with exit code 1.
  test(
    "download with invalid UUID exits 1 with Go-format message",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(
        ["snippets", "download", "not-a-uuid", "--project-ref", TEST_PROJECT_REF],
        { entrypoint: "legacy", env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
      );
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain("invalid snippet ID");
    },
  );
});
