import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { test } from "../../../../../tests/helpers/live.ts";

test("dumps the remote schema to a file", async ({ cli, project, workspace }) => {
  const outFile = join(workspace.path, "schema.sql");
  const result = await cli(["db", "dump", "--db-url", project.dbUrl, "-f", outFile]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(existsSync(outFile)).toBe(true);
});
