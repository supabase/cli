import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

/**
 * Golden-path e2e: exercises the real compiled-binary boundary for the
 * Docker-free paths of `db reset` — the flag validations that run BEFORE the
 * local/remote split (so no container, config override, or seam subprocess is
 * touched). The full local/remote reset behavior is covered by the integration
 * suite with the bootstrap seam and DB connection mocked; booting a real stack is
 * deliberately out of scope here (matching the sibling `db diff` / `seed buckets`
 * legacy e2e tests).
 */
describe("supabase db reset (legacy)", () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "supabase-db-reset-e2e-"));
    mkdirSync(join(projectDir, "supabase"), { recursive: true });
    writeFileSync(join(projectDir, "supabase", "config.toml"), 'project_id = "test"\n');
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("rejects mutually exclusive target flags", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabase(["db", "reset", "--linked", "--local"], {
      entrypoint: "legacy",
      cwd: projectDir,
    });
    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain(
      "if any flags in the group [db-url linked local] are set none of the others can be",
    );
  });

  test("rejects a non-integer --version", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabase(
      ["db", "reset", "--version", "not-a-number"],
      { entrypoint: "legacy", cwd: projectDir },
    );
    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain("invalid version number");
  });

  test("rejects --version together with --last", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabase(
      ["db", "reset", "--linked", "--version", "20240101000000", "--last", "1"],
      { entrypoint: "legacy", cwd: projectDir },
    );
    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain(
      "if any flags in the group [last version] are set none of the others can be",
    );
  });
});
