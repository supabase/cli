import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const UNREACHABLE_DB_URL = "postgresql://postgres:postgres@127.0.0.1:1/postgres";

describe("supabase db push --skip-vault (legacy)", () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "supabase-db-push-skip-vault-e2e-"));
    mkdirSync(join(projectDir, "supabase"), { recursive: true });
    writeFileSync(
      join(projectDir, "supabase", "config.toml"),
      '[db.vault]\nmy_secret = "encrypted:not-valid"\n',
    );
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("fails during config loading without the flag", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { exitCode, stderr } = await runSupabase(["db", "push", "--db-url", UNREACHABLE_DB_URL], {
      entrypoint: "legacy",
      cwd: projectDir,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("failed to parse config:");
    expect(stderr).not.toContain("Connecting to remote database...");
  });

  test(
    "reaches the database connection without decrypting vault secrets",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stderr } = await runSupabase(
        ["db", "push", "--db-url", UNREACHABLE_DB_URL, "--skip-vault"],
        { entrypoint: "legacy", cwd: projectDir },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Connecting to remote database...");
      expect(stderr).toContain("failed to connect");
      expect(stderr).not.toContain("failed to parse config:");
    },
  );
});
