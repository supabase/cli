import { expect } from "vitest";

import {
  experimentalProjectLiveFlags,
  requireLiveJson,
  test,
} from "../../../../../tests/helpers/live.ts";

test("reads the network restrictions of the target project", async ({ cli, project }) => {
  const result = await cli([
    "network-restrictions",
    "get",
    ...experimentalProjectLiveFlags(project),
    "-o",
    "json",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(requireLiveJson(result, "network-restrictions get"), result.stdout).toMatchObject({
    entitlement: expect.stringMatching(/^(?:allowed|disallowed)$/u),
    config: expect.any(Object),
    status: expect.stringMatching(/^(?:stored|applied)$/u),
  });
});
