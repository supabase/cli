import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import { runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const TEST_PROJECT_REF = "abcdefghijklmnopqrst";

describe("supabase unlink (legacy)", () => {
  // Golden path: with a seeded `supabase/.temp/project-ref`, a real subprocess
  // removes the temp dir and prints the Finished line. No network is involved.
  test(
    "removes supabase/.temp and prints Finished when linked",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const projectDir = mkdtempSync(join(tmpdir(), "sb-unlink-e2e-"));
      try {
        mkdirSync(join(projectDir, "supabase", ".temp"), { recursive: true });
        writeFileSync(join(projectDir, "supabase", ".temp", "project-ref"), TEST_PROJECT_REF);

        const { exitCode, stdout, stderr } = await runSupabase(["unlink"], {
          entrypoint: "legacy",
          cwd: projectDir,
        });

        expect(exitCode).toBe(0);
        expect(stdout).toContain("Finished supabase unlink.");
        expect(stderr).toContain(`Unlinking project: ${TEST_PROJECT_REF}`);
        expect(existsSync(join(projectDir, "supabase", ".temp"))).toBe(false);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    },
  );

  // The not-linked path exits non-zero with Go's `ErrNotLinked` message.
  test(
    "without a linked project exits 1 with the not-linked message",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const projectDir = mkdtempSync(join(tmpdir(), "sb-unlink-e2e-"));
      try {
        const { exitCode, stdout, stderr } = await runSupabase(["unlink"], {
          entrypoint: "legacy",
          cwd: projectDir,
        });
        expect(exitCode).toBe(1);
        expect(`${stdout}${stderr}`).toContain("Cannot find project ref");
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    },
  );
});
