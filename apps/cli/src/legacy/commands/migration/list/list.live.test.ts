import { expect } from "vitest";

import { testLiveDataPlane } from "../../../../../tests/helpers/live-context.ts";

testLiveDataPlane("lists migrations from the remote database", async ({ run, dbUrl }) => {
  const result = await run(["migration", "list", "--db-url", dbUrl]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).not.toContain("Unauthorized");
});

testLiveDataPlane("emits migration list as JSON", async ({ run, dbUrl }) => {
  const result = await run(["migration", "list", "--db-url", dbUrl, "--output-format", "json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(() => JSON.parse(result.stdout)).not.toThrow();
});
