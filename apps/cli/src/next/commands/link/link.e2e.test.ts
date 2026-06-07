import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../../tests/helpers/cli.ts";

const LINK_TIMEOUT_MS = 5_000;

describe("supabase link", () => {
  test(
    "fails with platform auth error instead of root fallback services",
    { timeout: LINK_TIMEOUT_MS },
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "supabase-link-e2e-"));
      const projectRoot = join(tempDir, "repo");

      try {
        await mkdir(join(projectRoot, "supabase"), { recursive: true });
        await writeFile(join(projectRoot, "supabase", "config.toml"), "# test project\n");

        const { stdout, stderr, exitCode } = await runSupabase(
          ["link", "--project-ref", "abcdefghijklmnopqrst"],
          { cwd: projectRoot },
        );

        expect(exitCode).toBe(1);
        expect(`${stdout}${stderr}`).toContain("You are not logged in to Supabase.");
        expect(`${stdout}${stderr}`).not.toContain("unexpected root credentials access");
        expect(`${stdout}${stderr}`).not.toContain("unexpected root platform api client access");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );
});
