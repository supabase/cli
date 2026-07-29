import { describe, expect, test } from "vitest";

import { makeTempHome, runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase feedback (legacy)", () => {
  // Golden path through the real CLI surface: the `btw` alias resolves in the
  // command parser (unreachable from handler-level integration tests) and the
  // json acknowledgement lands on stdout. Pinned to --profile supabase-staging
  // so this posts one real row to the STAGING feedback project per run
  // (staging exists for local dev/tests), never to production.
  test(
    "btw alias submits feedback to staging and prints a json acknowledgement",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const { exitCode, stdout } = await runSupabase(
        [
          "btw",
          "cli-e2e golden path (feedback.e2e.test.ts)",
          "--profile",
          "supabase-staging",
          "--output-format",
          "json",
        ],
        {
          entrypoint: "legacy",
          home: home.dir,
          env: { HOME: home.dir },
        },
      );
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ message: "Thanks for the feedback!" });
    },
  );
});
