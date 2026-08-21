import { expect } from "vitest";

import { testLiveProject } from "../../../../../tests/helpers/live-context.ts";

testLiveProject("lists API keys for a project", async ({ run, projectRef }) => {
  const result = await run([
    "projects",
    "api-keys",
    "--project-ref",
    projectRef,
    "--output",
    "json",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  const rows = JSON.parse(result.stdout) as Array<{ name?: string; api_key?: string }>;
  expect(
    rows.some((key) => key.name === "anon" || key.api_key?.startsWith("sb_publishable_")),
  ).toBe(true);
});
