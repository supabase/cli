import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

/**
 * Golden-path e2e for CLI-1865: exercises the real compiled-binary boundary —
 * `signing-key.command.ts`'s actual production runtime layer, not the mocked
 * `Stdin` the integration suite provides via `Layer.succeed`. A missing
 * `stdinLayer` in that composition only surfaces as a "Service not found" defect
 * at this boundary (see the legacy CLAUDE.md Go Parity Checklist item 5). Per-branch
 * prompt/format coverage lives in the integration suite.
 */
describe("supabase gen signing-key (legacy)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "supabase-gen-signing-key-e2e-"));
    mkdirSync(join(projectDir, "supabase"), { recursive: true });
    writeFileSync(
      join(projectDir, "supabase", "config.toml"),
      '[auth]\nsigning_keys_path = "./signing_keys.json"\n',
    );
    writeFileSync(join(projectDir, "supabase", "signing_keys.json"), "[]\n");
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test(
    "declines the overwrite on a piped 'n' without crashing or writing the file",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stderr } = await runSupabase(["gen", "signing-key"], {
        entrypoint: "legacy",
        cwd: projectDir,
        stdin: "n\n",
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("context canceled");
      expect(stderr).not.toContain("Service not found");
      const saved = readFileSync(join(projectDir, "supabase", "signing_keys.json"), "utf8");
      expect(JSON.parse(saved)).toEqual([]);
    },
  );

  test("overwrites on a piped 'y'", { timeout: E2E_TIMEOUT_MS }, async () => {
    const { exitCode, stderr } = await runSupabase(["gen", "signing-key"], {
      entrypoint: "legacy",
      cwd: projectDir,
      stdin: "y\n",
    });
    expect(exitCode).toBe(0);
    expect(stderr).toContain("JWT signing key appended to:");
    const saved = readFileSync(join(projectDir, "supabase", "signing_keys.json"), "utf8");
    expect(JSON.parse(saved)).toHaveLength(1);
  });
});
