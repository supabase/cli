import { Data, Effect, Schema } from "effect";
import { expect } from "vitest";

import { requireLiveSuccess, test } from "../../../tests/helpers/live.ts";

/** Typed live failures; `message` is a field so vitest can serialize the error. */
class PullLiveError extends Data.TaggedError("PullLiveError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Golden path only: the real four-step orchestration reaching a live Management API and its
// project's data plane in one pass, against a fresh `supabase init` checkout. Branch coverage for
// other dispositions lives in pull.aggregate.unit.test.ts and handler-level integration tests.
test("pulls config, migration history, db schema, and functions from a fresh project", ({
  cliEffect,
  project,
  signal,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* cliEffect([
        "pull",
        "--project-ref",
        project.ref,
        "--output-format",
        "json",
        "--yes",
      ]);
      yield* Effect.try({
        try: () => requireLiveSuccess(result, "pull"),
        catch: (error) =>
          new PullLiveError({
            message: error instanceof Error ? error.message : String(error),
            cause: error,
          }),
      });

      const payload = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        result.stdout,
      );
      expect(payload).toEqual(
        expect.objectContaining({
          schema_version: 1,
          target: expect.objectContaining({ project_ref: project.ref }),
          steps: expect.objectContaining({
            config: expect.objectContaining({ status: expect.not.stringMatching(/^failed$/) }),
            migration_history: expect.objectContaining({
              status: expect.not.stringMatching(/^failed$/),
            }),
            db: expect.objectContaining({ status: expect.not.stringMatching(/^failed$/) }),
            functions: expect.objectContaining({ status: expect.not.stringMatching(/^failed$/) }),
          }),
        }),
      );
      expect(payload).toMatchObject({ counts: { failed: 0 } });
    }),
    { signal },
  ));
