import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "vitest";

import { requireLiveSuccess, test } from "../../../../../tests/helpers/live.ts";

test("deletes a deployed function", async ({ cli, project, workspace }) => {
  const slug = `cli-e2e-delete-${randomUUID().slice(0, 8)}`;
  const directory = `${workspace.path}/supabase/functions/${slug}`;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/index.ts`, "Deno.serve(() => Response.json({ ok: true }));\n");
  await writeFile(`${directory}/deno.json`, '{\n  "imports": {}\n}\n');

  const deployed = await cli([
    "functions",
    "deploy",
    slug,
    "--project-ref",
    project.ref,
    "--use-api",
  ]);
  requireLiveSuccess(deployed, "functions deploy setup");

  let deleted = false;
  try {
    const result = await cli(["functions", "delete", slug, "--project-ref", project.ref]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Deleted Function");
    deleted = true;
  } finally {
    if (!deleted) {
      const cleanup = await cli(["functions", "delete", slug, "--project-ref", project.ref]);
      requireLiveSuccess(cleanup, "functions delete cleanup");
    }
  }
});
