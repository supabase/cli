import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { experimentalProjectLiveFlags, test } from "../../../../tests/helpers/live.ts";

test("reads the SSL enforcement posture of the target project", ({ cliEffect, project, signal }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* cliEffect([
        "ssl-enforcement",
        "get",
        ...experimentalProjectLiveFlags(project),
        "-o",
        "json",
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout, result.stderr).not.toBe("");
      const payload = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        result.stdout,
      );
      expect(payload, result.stdout).toMatchObject({
        currentConfig: { database: expect.any(Boolean) },
        appliedSuccessfully: expect.any(Boolean),
      });
    }),
    { signal },
  ));
