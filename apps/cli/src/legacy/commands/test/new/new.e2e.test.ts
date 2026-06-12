import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

/**
 * Golden-path e2e: `test new` writes a real file through the compiled-binary
 * boundary. Validates `Command.provide` + the runtime layer + FileSystem wiring.
 * Branch detail (json/stream-json, exists/write errors) is covered by the
 * integration suite.
 */
describe("supabase test new (legacy)", () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "supabase-test-new-e2e-"));
    mkdirSync(join(projectDir, "supabase"), { recursive: true });
    writeFileSync(join(projectDir, "supabase", "config.toml"), 'project_id = "test-new-e2e"\n');
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test(
    "scaffolds supabase/tests/<name>_test.sql and prints the created path",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabase(["test", "new", "pet"], {
        entrypoint: "legacy",
        cwd: projectDir,
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Created new pgtap test at");
      const target = join(projectDir, "supabase", "tests", "pet_test.sql");
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf8")).toContain("SELECT plan(1);");
    },
  );
});
