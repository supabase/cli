import { describe, expect, test } from "vitest";

import { makeTempHome, runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase feedback (legacy)", () => {
  // Golden path through the real CLI surface: the `btw` alias resolves in the
  // command parser (unreachable from handler-level integration tests) and the
  // json acknowledgement lands on stdout.
  test(
    "btw alias submits feedback and prints a json acknowledgement",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const { exitCode, stdout } = await runSupabase(
        ["btw", "e2e feedback message", "--output-format", "json"],
        {
          entrypoint: "legacy",
          home: home.dir,
          env: { HOME: home.dir },
        },
      );
      expect(exitCode).toBe(0);
      const payload = JSON.parse(stdout);
      expect(payload).toMatchObject({ message: "Thanks for the feedback!" });
      expect(payload.id).toEqual(expect.any(String));
      expect(payload.submitted_at).toEqual(expect.any(String));
    },
  );
});
