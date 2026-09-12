import { expect } from "vitest";
import { Effect, Schema } from "effect";
import { test } from "../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 60_000;

// Exercises the full live path — built binary, profile resolution, authenticated Management
// API request — with a read-only call that's safe to rerun and creates no resources.
test(
  "lists organizations for the authenticated token",
  { timeout: LIVE_TIMEOUT_MS },
  ({ cliEffect }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { exitCode, stdout, stderr } = yield* cliEffect(["orgs", "list", "--output", "json"]);
        expect(exitCode, stderr).toBe(0);
        const orgs = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(stdout);
        expect(orgs, stderr).not.toHaveLength(0);
      }),
    ),
);
