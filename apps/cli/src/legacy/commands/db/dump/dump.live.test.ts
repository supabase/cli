import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { testLiveDataPlane } from "../../../../../tests/helpers/live-context.ts";

testLiveDataPlane("dumps the remote schema to a file", async ({ run, dbUrl, workspace }) => {
  const outFile = join(workspace.path, "schema.sql");
  const result = await run(["db", "dump", "--db-url", dbUrl, "-f", outFile]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(existsSync(outFile)).toBe(true);
});
