import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "vitest";

import { requireLiveSuccess, testLiveProject } from "../../../../../tests/helpers/live-context.ts";

testLiveProject("deletes a deployed function", async ({ run, projectRef, workspace }) => {
  const slug = `cli-e2e-delete-${randomUUID().slice(0, 8)}`;
  const directory = `${workspace.path}/supabase/functions/${slug}`;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/index.ts`, "Deno.serve(() => Response.json({ ok: true }));\n");
  await writeFile(`${directory}/deno.json`, '{\n  "imports": {}\n}\n');

  const deployed = await run([
    "functions",
    "deploy",
    slug,
    "--project-ref",
    projectRef,
    "--use-api",
  ]);
  requireLiveSuccess(deployed, "functions deploy setup");

  let deleted = false;
  try {
    const result = await run(["functions", "delete", slug, "--project-ref", projectRef]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Deleted Function");
    deleted = true;
  } finally {
    if (!deleted) {
      const cleanup = await run(["functions", "delete", slug, "--project-ref", projectRef]);
      requireLiveSuccess(cleanup, "functions delete cleanup");
    }
  }
});
