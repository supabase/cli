import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runSupabase, stripAnsi } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase migration fetch", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "sb-mig-fetch-e2e-"));
    mkdirSync(join(workdir, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "config.toml"), "[db]\nport = 54322\n");
    writeFileSync(
      join(workdir, "supabase", "migrations", "20240101000000_existing.sql"),
      "select 1;\n",
    );
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  // Exercises the real Stdin wiring; in-process tests inject a mock Stdin and can't
  // catch a missing real-stdin layer.
  test(
    "reads a piped 'n' answer to the overwrite prompt and cancels",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stderr } = await runSupabase(["migration", "fetch", "--local"], {
        cwd: workdir,
        stdin: "n\n",
      });

      expect(exitCode).toBe(1);
      expect(stripAnsi(stderr)).toContain("[Y/n]");
      // A declined prompt exits with a lone "context canceled" line and no --debug hint.
      const lines = stripAnsi(stderr).trimEnd().split("\n");
      expect(lines.at(-1)).toBe("context canceled");
      expect(stderr).not.toContain("Try rerunning the command with --debug");
      expect(readdirSync(join(workdir, "supabase", "migrations"))).toEqual([
        "20240101000000_existing.sql",
      ]);
    },
  );
});
