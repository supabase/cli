// oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import -- this live test drives the real CLI and creates unique remote resources.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "vitest";

import { test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";

async function cleanupFunction(
  cli: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  slug: string,
  ref: string,
): Promise<void> {
  const deleted = await cli(["functions", "delete", slug, "--project-ref", ref]);
  if (
    deleted.exitCode !== 0 &&
    !/not found|does not exist/i.test(`${deleted.stdout}\n${deleted.stderr}`)
  ) {
    throw new Error(`functions delete cleanup failed:\n${deleted.stdout}\n${deleted.stderr}`);
  }
}

test("deletes a deployed function", async ({ cli, project, workspace }) => {
  const slug = `cli-e2e-delete-${randomUUID().slice(0, 8)}`;
  const directory = `${workspace.path}/supabase/functions/${slug}`;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/index.ts`, "Deno.serve(() => Response.json({ ok: true }));\n");
  await writeFile(`${directory}/deno.json`, '{\n  "imports": {}\n}\n');

  let targetError: unknown;
  let cleanupError: unknown;
  try {
    const deployed = await cli([
      "functions",
      "deploy",
      slug,
      "--project-ref",
      project.ref,
      "--use-api",
    ]);
    if (deployed.exitCode !== 0) {
      throw new Error(
        `functions deploy setup failed (exit ${deployed.exitCode})\nstdout:\n${deployed.stdout}\nstderr:\n${deployed.stderr}`,
      );
    }

    const result = await cli(["functions", "delete", slug, "--project-ref", project.ref]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Deleted Function");
  } catch (error) {
    targetError = error;
  } finally {
    try {
      await cleanupFunction(cli, slug, project.ref);
    } catch (error) {
      cleanupError = error;
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
