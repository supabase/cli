import { expect } from "vitest";
import { Effect, Schema } from "effect";

import { test } from "../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 60_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const jsonValue = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

// Golden path against the real feedback backend: `feedback add` resolves
// through the command parser's subcommand routing, submits through the real
// `submit_interfaces_feedback` RPC, and the json acknowledgement carries the
// server-issued delete token. `feedback delete` then removes the row with
// that token — proving the full add → delete round trip AND cleaning the
// staging row up each run. Pinned to --profile supabase-staging (the explicit
// flag outranks the fixture's SUPABASE_PROFILE env) so this only ever touches
// the STAGING feedback project (staging exists for local dev/tests), never
// production.
test(
  "feedback add returns a delete token that feedback delete accepts",
  { timeout: LIVE_TIMEOUT_MS },
  ({ cliEffect, signal }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const message = "cli-e2e golden path (add.live.test.ts)";
        const runDelete = (token: string) =>
          cliEffect([
            "feedback",
            "delete",
            token,
            "--yes",
            "--profile",
            "supabase-staging",
            "--output-format",
            "json",
          ]);

        // Captured before asserting so cleanup below still has a handle.
        let token: string | undefined;
        let cleaned = false;
        yield* Effect.gen(function* () {
          const added = yield* cliEffect([
            "feedback",
            "add",
            message,
            "--profile",
            "supabase-staging",
            "--output-format",
            "json",
          ]);
          expect(added.exitCode, added.stderr).toBe(0);
          const receipt: unknown = yield* jsonValue(added.stdout);
          if (
            receipt !== null &&
            typeof receipt === "object" &&
            "delete_token" in receipt &&
            typeof receipt.delete_token === "string"
          ) {
            token = receipt.delete_token;
          }
          expect(receipt).toEqual({
            delete_token: expect.stringMatching(UUID_PATTERN),
            message: "Thanks for the feedback!",
          });

          const deleted = yield* runDelete(token ?? "");
          cleaned = deleted.exitCode === 0;
          expect(deleted.exitCode, deleted.stderr).toBe(0);
          const acknowledgement: unknown = yield* jsonValue(deleted.stdout);
          expect(acknowledgement).toEqual({ message: "Feedback deleted." });
        }).pipe(
          // Best-effort teardown, keyed by exact token: never leave this test's
          // row on the staging project.
          Effect.ensuring(
            Effect.suspend(() =>
              token !== undefined && !cleaned
                ? runDelete(token).pipe(Effect.ignoreCause)
                : Effect.void,
            ),
          ),
        );
      }),
      { signal },
    ),
);
