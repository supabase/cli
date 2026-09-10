import { expect } from "vitest";

import { requireLiveJson, test } from "../../../tests/helpers/live.ts";

test("shows the profile for the authenticated token", async ({ cli }) => {
  const result = await cli(["whoami", "--output-format", "json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(requireLiveJson(result, "whoami")).toEqual({
    gotrue_id: expect.any(String),
    primary_email: expect.any(String),
    username: expect.any(String),
  });
});
