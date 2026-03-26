import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PROJECT_CONFIG_SCHEMA_URL } from "@supabase/config";
import { runSupabase } from "../../../tests/helpers/cli.ts";

const INIT_TIMEOUT_MS = 5_000;

describe("supabase init", () => {
  test(
    "creates a minimal config.json in the current directory",
    { timeout: INIT_TIMEOUT_MS },
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "supabase-init-e2e-"));

      try {
        const { stdout, exitCode } = await runSupabase(["init"], { cwd: tempDir });

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Initialized Supabase project.");

        const content = await readFile(join(tempDir, "supabase", "config.json"), "utf8");
        expect(JSON.parse(content)).toEqual({
          $schema: PROJECT_CONFIG_SCHEMA_URL,
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );
});
