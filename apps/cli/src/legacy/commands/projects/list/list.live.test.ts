import { expect } from "vitest";

import { test } from "../../../../../tests/helpers/live.ts";

test("lists the live project for the authenticated token", async ({ run, projectRef }) => {
  const result = await run(["projects", "list", "--output-format", "json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  const parsed: unknown = JSON.parse(result.stdout);
  expect(parsed).toEqual(expect.objectContaining({ projects: expect.any(Array) }));
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("projects" in parsed) ||
    !Array.isArray(parsed.projects)
  ) {
    throw new Error("projects list JSON response did not contain a projects array");
  }
  const refs = parsed.projects.flatMap((project) => {
    if (project === null || typeof project !== "object") return [];
    if ("ref" in project && typeof project.ref === "string") return [project.ref];
    if ("id" in project && typeof project.id === "string") return [project.id];
    return [];
  });
  expect(refs).toContain(projectRef);
});

test("emits projects as JSON for an account-level read", async ({ run }) => {
  const result = await run(["projects", "list", "--output-format", "json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(() => JSON.parse(result.stdout)).not.toThrow();
});
