import { expect } from "vitest";

import { experimentalProjectLiveFlags, test } from "../../../../../tests/helpers/live.ts";

test("reads the SSL enforcement posture of the target project", async ({ cli, project }) => {
  const result = await cli([
    "ssl-enforcement",
    "get",
    ...experimentalProjectLiveFlags(project),
    "-o",
    "json",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout, result.stderr).not.toBe("");
  expect(JSON.parse(result.stdout), result.stdout).toMatchObject({
    currentConfig: { database: expect.any(Boolean) },
    appliedSuccessfully: expect.any(Boolean),
  });
});
