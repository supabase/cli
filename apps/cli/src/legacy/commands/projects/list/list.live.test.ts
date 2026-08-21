import { expect } from "vitest";

import { testLive, testLiveProject } from "../../../../../tests/helpers/live-context.ts";

testLiveProject(
  "lists the live project for the authenticated token",
  async ({ run, projectRef }) => {
    const result = await run(["projects", "list", "--output-format", "json"]);
    expect(result.exitCode, result.stderr).toBe(0);
    const projects = JSON.parse(result.stdout) as Array<{ id?: string; ref?: string }>;
    expect(projects.map((project) => project.ref ?? project.id)).toContain(projectRef);
  },
);

testLive("emits projects as JSON for an account-level read", async ({ run }) => {
  const result = await run(["projects", "list", "--output-format", "json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(() => JSON.parse(result.stdout)).not.toThrow();
});
