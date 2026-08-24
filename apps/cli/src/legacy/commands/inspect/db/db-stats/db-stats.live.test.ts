// oxlint-disable effecttsgo/async-function -- this live test uses Vitest's Promise surface to drive the real CLI.
import { expect } from "vitest";

import { test } from "../../../../../../tests/helpers/live.ts";

test("reports statistics from the remote database", async ({ cli, project }) => {
  const result = await cli(["inspect", "db", "db-stats", "--db-url", project.dbUrl]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("Database Size");
});
