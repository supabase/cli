import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, "");

describe("supabase migration fetch (legacy)", () => {
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

  // Real-subprocess guard for the production Stdin wiring + Go-style prompt: a piped
  // answer to the overwrite prompt must actually be read, not auto-defaulted. A declined
  // `n` cancels before connecting, so no DB is required. This is the boundary in-process
  // tests cannot cover — they inject a mock Stdin, which masked a missing-service bug
  // where the migration DB runtime never provided the real stdin layer.
  test(
    "reads a piped 'n' answer to the overwrite prompt and cancels",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stderr } = await runSupabase(["migration", "fetch", "--local"], {
        entrypoint: "legacy",
        cwd: workdir,
        stdin: "n\n",
      });

      // Declined → cancelled (non-zero), and the Go-style prompt label reached stderr.
      expect(exitCode).not.toBe(0);
      expect(stripAnsi(stderr)).toContain("[Y/n]");
      // The existing file was NOT overwritten — the piped answer was honored.
      expect(readdirSync(join(workdir, "supabase", "migrations"))).toEqual([
        "20240101000000_existing.sql",
      ]);
    },
  );
});
