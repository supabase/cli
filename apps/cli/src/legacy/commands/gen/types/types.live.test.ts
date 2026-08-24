// oxlint-disable effecttsgo/async-function -- this live test uses Vitest's Promise surface to drive the real CLI.
import { expect } from "vitest";

import { test } from "../../../../../tests/helpers/live.ts";

test("generates TypeScript types from the remote schema", async ({ cli, project }) => {
  const result = await cli(["gen", "types", "--db-url", project.dbUrl, "--lang", "typescript"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/export type (Database|Json)/);
});
