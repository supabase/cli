// oxlint-disable effecttsgo/async-function -- this live test uses Vitest's Promise surface to drive the real CLI.
import { expect } from "vitest";

import { test } from "../../../../../tests/helpers/live.ts";

test("lists API keys for a project", async ({ cli, project }) => {
  const result = await cli([
    "projects",
    "api-keys",
    "--project-ref",
    project.ref,
    "--output",
    "json",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  const rows = JSON.parse(result.stdout) as Array<{ name?: string; api_key?: string }>;
  expect(
    rows.some((key) => key.name === "anon" || key.api_key?.startsWith("sb_publishable_")),
  ).toBe(true);
});
