import { expect, test } from "vitest";

import { makeTempHome } from "../../../../../tests/helpers/cli.ts";
import { describeLive, runSupabaseLive } from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 60_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describeLive("supabase feedback (legacy, live)", () => {
  // Golden path against the real feedback backend: `feedback add` resolves
  // through the command parser's subcommand routing, submits through the real
  // `submit_interfaces_feedback` RPC, and the json acknowledgement carries the
  // server-issued delete token. `feedback delete` then removes the row with
  // that token — proving the full add → delete round trip AND cleaning the
  // staging row up each run. Pinned to --profile supabase-staging so this only
  // ever touches the STAGING feedback project (staging exists for local
  // dev/tests), never production.
  test(
    "feedback add returns a delete token that feedback delete accepts",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const message = "cli-e2e golden path (add.live.test.ts)";
      const added = await runSupabaseLive(
        ["feedback", "add", message, "--profile", "supabase-staging", "--output-format", "json"],
        {
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

      const deleted = await runSupabaseLive(
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
