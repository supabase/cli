import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

/**
 * Golden-path e2e for the `storage` group: the real compiled-binary surface and
 * the parser boundary for the persistent `--linked`/`--local` flags. Object
 * list/copy/move/remove parity is covered by the integration + unit suites
 * (they don't need a live local stack); these only exercise what the in-process
 * suites bypass.
 */
describe("supabase storage (legacy)", () => {
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
      entrypoint: "legacy",
      cwd: projectDir,
    });
    expect(exitCode).toBe(0);
    for (const sub of ["ls", "cp", "mv", "rm"]) {
      expect(stdout).toContain(sub);
    }
  });

  test("rejects passing both --local and --linked", { timeout: E2E_TIMEOUT_MS }, async () => {
    // Go validates flag groups (mutual exclusivity) BEFORE the experimental gate
    // in PersistentPreRunE, so this fails on the mutex even without --experimental.
    const { exitCode, stdout, stderr } = await runSupabase(
      ["storage", "ls", "--local", "--linked", "ss:///"],
      { entrypoint: "legacy", cwd: projectDir },
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
      // `storageCmd` is in Go's experimental slice (root.go:63); running it without
      // --experimental is rejected by the PersistentPreRunE gate (root.go:91-96).
      const { exitCode, stdout, stderr } = await runSupabase(
        ["storage", "ls", "ss:///", "--local"],
        {
          entrypoint: "legacy",
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
    // `--linked`/`--local` are per-leaf flags (Effect CLI requires unique
    // global-flag names tree-wide and `seed` owns them), so they follow the
    // subcommand. With --experimental it parses and passes the gate; there's no
    // live local stack so it fails to connect — but it must PARSE (no
    // "Unrecognized flag") and must NOT be blocked by the experimental gate.
    const { stdout, stderr } = await runSupabase(
      ["storage", "ls", "ss:///", "--local", "--experimental"],
      { entrypoint: "legacy", cwd: projectDir },
    );
    const combined = `${stdout}${stderr}`;
    expect(combined).not.toContain("Unrecognized flag");
    expect(combined).not.toContain("must set the --experimental flag");
  });
});
