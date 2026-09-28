import { randomUUID } from "node:crypto";

import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { test } from "../../../../tests/helpers/live.ts";

const decodeRows = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

test("runs SQL against the remote database and returns its rows", ({
  cliEffect,
  project,
  signal,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const marker = `e2e_query_${randomUUID().slice(0, 8)}`;
      const result = yield* cliEffect([
        "db",
        "query",
        `select '${marker}' as marker`,
        "--db-url",
        project.dbUrl,
        "-o",
        "json",
        "--agent",
        "no",
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout, result.stderr).not.toBe("");
      expect(yield* decodeRows(result.stdout)).toEqual([{ marker }]);
    }),
    { signal },
  ));
