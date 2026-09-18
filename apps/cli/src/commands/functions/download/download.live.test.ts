import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";

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

describe("functions download (live)", () => {
  test("round-trips a deployed function's source through the live project", async ({
    cli,
    project,
    workspace,
  }) => {
    const slug = `cli-e2e-download-${randomUUID().slice(0, 8)}`;
    const marker = randomUUID();
    const directory = join(workspace.path, "supabase", "functions", slug);
    const entrypoint = join(directory, "index.ts");
    await mkdir(directory, { recursive: true });
    await writeFile(
      entrypoint,
      `Deno.serve(() => Response.json({ marker: ${JSON.stringify(marker)}, ok: true }));\n`,
    );
    await writeFile(join(directory, "deno.json"), '{\n  "imports": {}\n}\n');

    let targetError: unknown;
    let cleanupError: unknown;
    try {
      const deployed = await cli(["functions", "deploy", "--project-ref", project.ref]);
      requireLiveSuccess(deployed, "functions deploy setup");

      await rm(directory, { recursive: true, force: true });
      expect(existsSync(entrypoint), "local function source should be gone before download").toBe(
        false,
      );

      // The unbundle container writes as root; pre-create the directory
      // host-owned and world-writable (mirroring the deploy bundler's own
      // pre-created output dir) so the CI runner can remove it afterward.
      await mkdir(directory, { recursive: true });
      await chmod(directory, 0o777);

      const downloaded = await cli(["functions", "download", slug, "--project-ref", project.ref]);
      const downloadOutput = `stdout:\n${downloaded.stdout}\nstderr:\n${downloaded.stderr}`;
      expect(downloaded.exitCode, downloadOutput).toBe(0);
      // Lowercase "function:" pins the docker unbundle path specifically,
      // distinct from the server-fallback's "Downloading Function:".
      expect(downloaded.stderr, downloadOutput).toContain("Downloading function:");
      expect(existsSync(entrypoint), downloadOutput).toBe(true);
      const roundTripped = await readFile(entrypoint, "utf8");
      expect(roundTripped, downloadOutput).toContain(marker);
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
