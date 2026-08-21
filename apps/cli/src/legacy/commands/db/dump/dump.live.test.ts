import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import {
  liveDatabaseTargetArgs,
  testLiveDataPlane,
} from "../../../../../tests/helpers/live-context.ts";

testLiveDataPlane(
  "dumps the remote schema to a file",
  async ({ run, dbUrl, projectRef, workspace }) => {
    const outFile = join(workspace.path, "schema.sql");
    const result = await run([
      "db",
      "dump",
      ...liveDatabaseTargetArgs(dbUrl, projectRef),
      "-f",
      outFile,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(outFile)).toBe(true);
  },
);
