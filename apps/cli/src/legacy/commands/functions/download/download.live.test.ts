import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";

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
  // End to end artifact round trip: deploy a function whose source carries a
  // unique marker, remove every local trace of it, download it back from the
  // live project, and assert the marker survived — local source → platform
  // bundle → unbundled back to disk.
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

      // The unbundle container creates missing output directories as root,
      // which the CI runner user cannot remove at workspace teardown.
      // Pre-create the directory host-owned and world-writable so any
      // container uid can write into it — the deploy bundler pre-creates its
      // container output dir the same way. This works because the function is
      // flat: root-written files land directly in the host-owned dir, where
      // unlinking needs only write access on the parent.
      await mkdir(directory, { recursive: true });
      await chmod(directory, 0o777);

      const downloaded = await cli(["functions", "download", slug, "--project-ref", project.ref]);
      const downloadOutput = `stdout:\n${downloaded.stdout}\nstderr:\n${downloaded.stderr}`;
      expect(downloaded.exitCode, downloadOutput).toBe(0);
      // The docker unbundle path banners "Downloading function:" (lowercase f)
      // while the server-side fallback banners "Downloading Function:" — pin
      // the docker journey positively so a silent downgrade fails loudly.
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
