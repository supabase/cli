import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { experimentalProjectLiveFlags, test } from "../../../../tests/helpers/live.ts";

// A config override map: any key, but never an array, `null` or a scalar.
const PostgresConfigPayload = Schema.Record(Schema.String, Schema.Unknown);

// A freshly provisioned project can have zero overrides, so the golden path
// pins the payload shape rather than any key: exit 0 and a JSON object on
// payload-only stdout.
test("reads the current config of the target project", ({ cliEffect, project, signal }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* cliEffect([
        "postgres-config",
        "get",
        ...experimentalProjectLiveFlags(project),
        "-o",
        "json",
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout, result.stderr).not.toBe("");
      const config = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        result.stdout,
      );
      expect(
        Schema.is(PostgresConfigPayload)(config),
        `unexpected postgres-config get payload\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(true);
    }),
    { signal },
  ));
