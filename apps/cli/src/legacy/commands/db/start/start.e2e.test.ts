import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

/**
 * Golden-path e2e: exercises the real compiled-binary boundary for the one
 * environment-independent path of `db start` — a malformed `config.toml`, which
 * the handler validates BEFORE the "already running?" probe, so it fails fast
 * without touching Docker. The container-bootstrap behavior (the running check,
 * the `__db-bootstrap` seam, the "already running" line) is covered by the
 * integration suite with the seam mocked; booting a real Postgres container is
 * deliberately out of scope here (matching the sibling `db diff` / `seed buckets`
 * legacy e2e tests, none of which boot a live stack).
 */
describe("supabase db start (legacy)", () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "supabase-db-start-e2e-"));
    mkdirSync(join(projectDir, "supabase"), { recursive: true });
    // Invalid TOML — aborts config loading before any container work.
    writeFileSync(join(projectDir, "supabase", "config.toml"), 'project_id = "unterminated\n');
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("fails fast on a malformed config.toml", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabase(["db", "start"], {
      entrypoint: "legacy",
      cwd: projectDir,
    });
    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain("failed to parse supabase/config.toml");
  });
});
