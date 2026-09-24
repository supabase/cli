import { Effect } from "effect";
import { expect } from "vitest";

import { test } from "../../../../../tests/helpers/live.ts";

test("reports statistics from the remote database", ({ cliEffect, project, signal }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* cliEffect(["inspect", "db", "db-stats", "--db-url", project.dbUrl]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("Database Size");
    }),
    { signal },
  ));
