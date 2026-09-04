import { expect } from "vitest";

import { experimentalProjectLiveFlags, test } from "../../../../../tests/helpers/live.ts";

// A freshly provisioned project can have zero overrides, so the golden path
// pins the payload shape rather than any key: exit 0 and a JSON object on
// payload-only stdout.
test("reads the current config of the target project", async ({ cli, project }) => {
  const result = await cli([
    "postgres-config",
    "get",
    ...experimentalProjectLiveFlags(project),
    "-o",
    "json",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout, result.stderr).not.toBe("");
  const config: unknown = JSON.parse(result.stdout);
  expect(config, result.stdout).toBeTypeOf("object");
  expect(config, result.stdout).not.toBeNull();
  expect(Array.isArray(config), result.stdout).toBe(false);
});
