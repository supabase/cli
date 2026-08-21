import { expect } from "vitest";

import {
  liveDatabaseTargetArgs,
  testLiveDataPlane,
} from "../../../../../tests/helpers/live-context.ts";

testLiveDataPlane(
  "generates TypeScript types from the remote schema",
  async ({ run, dbUrl, projectRef }) => {
    const result = await run([
      "gen",
      "types",
      ...liveDatabaseTargetArgs(dbUrl, projectRef),
      "--lang",
      "typescript",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/export type (Database|Json)/);
  },
);
