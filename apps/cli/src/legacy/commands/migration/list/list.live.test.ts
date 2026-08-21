import { expect } from "vitest";

import {
  liveDatabaseTargetArgs,
  testLiveDataPlane,
} from "../../../../../tests/helpers/live-context.ts";

testLiveDataPlane(
  "lists migrations from the remote database",
  async ({ run, dbUrl, projectRef }) => {
    const result = await run(["migration", "list", ...liveDatabaseTargetArgs(dbUrl, projectRef)]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("Unauthorized");
  },
);

testLiveDataPlane("emits migration list as JSON", async ({ run, dbUrl, projectRef }) => {
  const result = await run([
    "migration",
    "list",
    ...liveDatabaseTargetArgs(dbUrl, projectRef),
    "--output-format",
    "json",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(() => JSON.parse(result.stdout)).not.toThrow();
});
