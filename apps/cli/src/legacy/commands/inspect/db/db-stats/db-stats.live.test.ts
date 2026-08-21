import { expect } from "vitest";

import { testLiveDataPlane } from "../../../../../../tests/helpers/live-context.ts";

testLiveDataPlane("reports statistics from the remote database", async ({ run, dbUrl }) => {
  const result = await run(["inspect", "db", "db-stats", "--db-url", dbUrl]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("Database Size");
});
