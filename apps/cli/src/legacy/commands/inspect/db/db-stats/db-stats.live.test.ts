import { expect } from "vitest";

import {
  liveDatabaseTargetArgs,
  testLiveDataPlane,
} from "../../../../../../tests/helpers/live-context.ts";

testLiveDataPlane(
  "reports statistics from the remote database",
  async ({ run, dbUrl, projectRef }) => {
    const result = await run([
      "inspect",
      "db",
      "db-stats",
      ...liveDatabaseTargetArgs(dbUrl, projectRef),
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Database Size");
  },
);
