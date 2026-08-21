import { expect } from "vitest";

import { testLiveDataPlane } from "../../../../../tests/helpers/live-context.ts";

testLiveDataPlane("generates TypeScript types from the remote schema", async ({ run, dbUrl }) => {
  const result = await run(["gen", "types", "--db-url", dbUrl, "--lang", "typescript"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/export type (Database|Json)/);
});
