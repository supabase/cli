import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const TEST_PROJECT_REF = "abcdefghijklmnopqrst";
const TEST_TOKEN = "sbp_" + "a".repeat(40);

/**
 * Golden-path e2e: exercises the real compiled-binary boundary for the only
 * network-free failure path in `config push` — a malformed `supabase/config.toml`
 * aborts before any API call. Validates that `Command.provide` + the runtime
 * layer + `withJsonErrorHandling` surface the parse error with exit code 1.
 * Per-service diff/output parity is covered by the unit + integration suites.
 */
describe("supabase config push (legacy)", () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "supabase-config-push-e2e-"));
    mkdirSync(join(projectDir, "supabase"), { recursive: true });
    writeFileSync(join(projectDir, "supabase", "config.toml"), "malformed");
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test(
    "aborts with exit 1 on a malformed config.toml before any network call",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(
        ["config", "push", "--project-ref", TEST_PROJECT_REF],
        { entrypoint: "legacy", cwd: projectDir, env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
      );
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain("config.toml");
    },
  );
});
