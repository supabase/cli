import { describe, expect, test } from "vitest";

import { makeTempHome, runSupabase } from "../../../../../tests/helpers/cli.ts";

import { LEGACY_FEEDBACK_EMPTY_MESSAGE } from "./add.errors.ts";

const E2E_TIMEOUT_MS = 60_000;

describe("supabase feedback (legacy)", () => {
  // Subcommand routing through the real parser is the only surface handler
  // integration tests can't reach. The empty-message path proves it with zero
  // network: no args, whitespace-only piped stdin, non-TTY — the command exits
  // 1 before any request could leave the process. The real-backend golden path
  // (add → delete round trip) lives in add.live.test.ts, gated to the
  // cli-e2e-ci runner.
  test(
    "feedback add fails with the empty-message error when nothing is provided",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const result = await runSupabase(["feedback", "add"], {
        entrypoint: "legacy",
        home: home.dir,
        env: { HOME: home.dir },
        stdin: "   \n",
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(LEGACY_FEEDBACK_EMPTY_MESSAGE);
      expect(result.stdout).toBe("");
    },
  );
});
