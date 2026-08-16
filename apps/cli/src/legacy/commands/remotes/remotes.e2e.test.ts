import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const REF = "abcdefghijklmnopqrst";

describe("supabase remotes (legacy)", () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "supabase-remotes-e2e-"));
    mkdirSync(join(projectDir, "supabase"), { recursive: true });
    writeFileSync(join(projectDir, "supabase", "config.toml"), 'project_id = "local"\n');
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test(
    "remotes add -> remotes list -> db push --remote (golden path)",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const add = await runSupabase(["remotes", "add", "staging", "--project-ref", REF], {
        entrypoint: "legacy",
        cwd: projectDir,
      });
      expect(add.exitCode).toBe(0);
      expect(add.stdout).toContain(`Added remote "staging" -> ${REF}.`);

      const list = await runSupabase(["remotes", "list"], {
        entrypoint: "legacy",
        cwd: projectDir,
      });
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("staging");
      expect(list.stdout).toContain(REF);

      // An unknown --remote name fails deterministically before any network
      // access — proving `--remote` threads all the way from argv parsing through
      // `LegacyProjectRefResolver` without requiring a real backend.
      const push = await runSupabase(["db", "push", "--remote", "ghost", "--dry-run"], {
        entrypoint: "legacy",
        cwd: projectDir,
      });
      expect(push.exitCode).toBe(1);
      expect(push.stderr).toContain('Unknown remote "ghost"');
      expect(push.stderr).toContain("supabase remotes add ghost");
    },
  );

  test("remotes remove deletes a registered remote", { timeout: E2E_TIMEOUT_MS }, async () => {
    const add = await runSupabase(["remotes", "add", "prod", "--project-ref", REF], {
      entrypoint: "legacy",
      cwd: projectDir,
    });
    expect(add.exitCode).toBe(0);

    const remove = await runSupabase(["remotes", "remove", "prod"], {
      entrypoint: "legacy",
      cwd: projectDir,
    });
    expect(remove.exitCode).toBe(0);
    expect(remove.stdout).toContain('Removed remote "prod".');

    const list = await runSupabase(["remotes", "list"], {
      entrypoint: "legacy",
      cwd: projectDir,
    });
    expect(list.stdout).not.toContain("prod");
  });
});
