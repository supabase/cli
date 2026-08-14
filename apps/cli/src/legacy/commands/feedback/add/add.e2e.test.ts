import { describe, expect, test } from "vitest";

import { makeTempHome, runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 60_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("supabase feedback (legacy)", () => {
  // Golden path through the real CLI surface: `feedback add` resolves through
  // the command parser's subcommand routing (unreachable from handler-level
  // integration tests), submits through the real `submit_interfaces_feedback`
  // RPC, and the json acknowledgement carries the server-issued delete token.
  // `feedback delete` then removes the row with that token — proving the full
  // add → delete round trip AND cleaning the staging row up each run. Pinned
  // to --profile supabase-staging so this only ever touches the STAGING
  // feedback project (staging exists for local dev/tests), never production.
  test(
    "feedback add returns a delete token that feedback delete accepts",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const message = "cli-e2e golden path (add.e2e.test.ts)";
      const added = await runSupabase(
        ["feedback", "add", message, "--profile", "supabase-staging", "--output-format", "json"],
        {
          entrypoint: "legacy",
          home: home.dir,
          env: { HOME: home.dir },
        },
      );
      expect(added.exitCode).toBe(0);
      const receipt = JSON.parse(added.stdout);
      expect(receipt).toEqual({
        delete_token: expect.stringMatching(UUID_PATTERN),
        message: "Thanks for the feedback!",
      });

      const deleted = await runSupabase(
        [
          "feedback",
          "delete",
          receipt.delete_token,
          "--yes",
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
      expect(deleted.exitCode).toBe(0);
      expect(JSON.parse(deleted.stdout)).toEqual({
        feedback: message,
        message: "Feedback deleted.",
      });
    },
  );
});
