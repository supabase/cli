import { expect } from "vitest";
import { Effect } from "effect";

import { test } from "../../../../tests/helpers/live.ts";

test("generates TypeScript types from the remote schema", ({ cliEffect, project, signal }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* cliEffect([
        "gen",
        "types",
        "--db-url",
        project.dbUrl,
        "--lang",
        "typescript",
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/export type (Database|Json)/);
    }),
    { signal },
  ));
