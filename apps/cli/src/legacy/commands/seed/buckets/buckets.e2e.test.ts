import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

/**
 * Golden-path e2e: exercises the real compiled-binary boundary for the two
 * network-free paths of `seed buckets`:
 *  - an empty `[storage]` config is a no-op (exit 0, no stdout);
 *  - `--local --linked` is rejected by the mutually-exclusive flag check.
 * Bucket/object seeding parity is covered by the integration + unit suites.
 */
describe("supabase seed buckets (legacy)", () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "supabase-seed-buckets-e2e-"));
    mkdirSync(join(projectDir, "supabase"), { recursive: true });
    writeFileSync(join(projectDir, "supabase", "config.toml"), 'project_id = "test"\n');
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test(
    "is a no-op with exit 0 when no buckets are configured",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabase(["seed", "buckets"], {
        entrypoint: "legacy",
        cwd: projectDir,
      });
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("");
    },
  );

  test("rejects passing both --local and --linked", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabase(
      ["seed", "buckets", "--local", "--linked"],
      { entrypoint: "legacy", cwd: projectDir },
    );
    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain(
      "if any flags in the group [linked local] are set none of the others can be",
    );
  });
});
