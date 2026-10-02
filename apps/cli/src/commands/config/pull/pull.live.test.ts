import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { requireLiveSuccess, test } from "../../../../tests/helpers/live.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

// Golden path only: the one thing mocks can't prove is a real
// `GET /v2/projects/{ref}/config` response decoding, planning, and writing cleanly against a
// real (freshly-initialized) config.toml, and that a second run against the same project leaves
// nothing to write. Branch coverage lives in pull.integration.test.ts.
test("pulls remote config into a fresh project, leaving nothing to write on a second run", ({
  cliEffect,
  project,
  signal,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const args = [
        "config",
        "pull",
        "--project-ref",
        project.ref,
        "--yes",
        "--output-format",
        "json",
      ];
      const first = yield* cliEffect(args);
      requireLiveSuccess(first, "config pull");
      expect(yield* decodeJson(first.stdout)).toEqual(expect.objectContaining({ wrote: true }));

      const second = yield* cliEffect(args);
      requireLiveSuccess(second, "config pull");
      expect(yield* decodeJson(second.stdout)).toEqual(
        expect.objectContaining({
          wrote: false,
          scope: expect.objectContaining({ present: expect.arrayContaining(["auth"]) }),
        }),
      );
    }),
    { signal },
  ));
