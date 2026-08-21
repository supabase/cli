import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { describe } from "vitest";

import { expectFunctionOk, test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";

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

describe("functions deploy (live)", () => {
  test("deploys a function that responds over HTTP", async ({
    cli,
    invoke,
    project,
    workspace,
  }) => {
    const slug = `cli-e2e-deploy-${randomUUID().slice(0, 8)}`;
    const directory = join(workspace.path, "supabase", "functions", slug);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "index.ts"),
      `Deno.serve(() => Response.json({ case: ${JSON.stringify(slug)}, ok: true }));\n`,
    );
    await writeFile(join(directory, "deno.json"), '{\n  "imports": {}\n}\n');

    let targetError: unknown;
    let cleanupError: unknown;
    try {
      const result = await cli(["functions", "deploy", "--project-ref", project.ref]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/Deployed Function/i);

      expectFunctionOk(await invoke(slug), slug);
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
});
