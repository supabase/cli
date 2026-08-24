import { expect } from "vitest";

import { test } from "../../../../../tests/helpers/live.ts";

test("lists migrations from the remote database", async ({ cli, project }) => {
  const result = await cli(["migration", "list", "--db-url", project.dbUrl]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).not.toContain("Unauthorized");
});
