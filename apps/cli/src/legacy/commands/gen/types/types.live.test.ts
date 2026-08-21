import { expect } from "vitest";

import { test } from "../../../../../tests/helpers/live.ts";

test("generates TypeScript types from the remote schema", async ({ run, dbUrl, projectRef }) => {
  const targetArgs = dbUrl.length > 0 ? ["--db-url", dbUrl] : ["--project-id", projectRef];
  const result = await run(["gen", "types", ...targetArgs, "--lang", "typescript"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/export type (Database|Json)/);
});
