import { expect } from "vitest";

import { experimentalProjectLiveFlags, test } from "../../../../../tests/helpers/live.ts";

test("reads the network restrictions of the target project", async ({ cli, project }) => {
  const result = await cli([
    "network-restrictions",
    "get",
    ...experimentalProjectLiveFlags(project),
    "-o",
    "json",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout, result.stderr).not.toBe("");
  expect(JSON.parse(result.stdout), result.stdout).toMatchObject({
    entitlement: expect.stringMatching(/^(?:allowed|disallowed)$/u),
    config: expect.any(Object),
    status: expect.stringMatching(/^(?:stored|applied)$/u),
  });
});
