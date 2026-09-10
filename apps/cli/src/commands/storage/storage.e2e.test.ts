import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runSupabase } from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

/**
 * Golden-path e2e for `storage`: the compiled binary and `--linked`/`--local` flag
 * parsing. Object list/copy/move/remove behavior is covered by the integration and
 * unit suites, which don't need a live local stack.
 */
describe("supabase storage", () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "supabase-storage-e2e-"));
    mkdirSync(join(projectDir, "supabase"), { recursive: true });
    writeFileSync(join(projectDir, "supabase", "config.toml"), 'project_id = "test"\n');
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("lists the four subcommands in --help", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { exitCode, stdout } = await runSupabase(["storage", "--help"], {
      cwd: projectDir,
    });
    expect(exitCode).toBe(0);
    for (const sub of ["ls", "cp", "mv", "rm"]) {
      expect(stdout).toContain(sub);
    }
  });

  test("rejects passing both --local and --linked", { timeout: E2E_TIMEOUT_MS }, async () => {
    // The experimental gate runs before the mutex check, so --experimental must be
    // set here to reach the mutex check at all.
    const { exitCode, stdout, stderr } = await runSupabase(
      ["storage", "ls", "--local", "--linked", "ss:///", "--experimental"],
      { cwd: projectDir },
    );
    expect(exitCode).toBe(1);
    expect(`${stdout}${stderr}`).toContain(
      "if any flags in the group [linked local] are set none of the others can be",
    );
  });

  test(
    "rejects storage subcommands without --experimental",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(
        ["storage", "ls", "ss:///", "--local"],
        {
          cwd: projectDir,
        },
      );
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain(
        "must set the --experimental flag to run this command",
      );
    },
  );

  test("accepts --local after the subcommand token", { timeout: E2E_TIMEOUT_MS }, async () => {
    // --linked/--local are per-leaf flags, not global ones — Effect CLI requires
    // unique global-flag names tree-wide and `seed` already owns those names.
    const { stdout, stderr } = await runSupabase(
      ["storage", "ls", "ss:///", "--local", "--experimental"],
      { cwd: projectDir },
    );
    const combined = `${stdout}${stderr}`;
    expect(combined).not.toContain("Unrecognized flag");
    expect(combined).not.toContain("must set the --experimental flag");
  });
});
