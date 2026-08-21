import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { describe } from "vitest";

import { expectFunctionOk, requireLiveSuccess, test } from "../../../../../tests/helpers/live.ts";

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

    let deployed = false;
    try {
      const result = await cli(["functions", "deploy", "--project-ref", project.ref]);
      expect(result.exitCode, result.stderr).toBe(0);
      deployed = true;
      expect(result.stdout).toMatch(/Deployed Function/i);

      expectFunctionOk(await invoke(slug), slug);
    } finally {
      if (deployed) {
        const deleted = await cli(["functions", "delete", slug, "--project-ref", project.ref]);
        requireLiveSuccess(deleted, "functions delete cleanup");
      }
    }
  });
});
