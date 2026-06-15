import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { makeTempHome, runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

// A definitely-closed local port: the `--db-url` is parsed directly (no config.toml
// / running stack needed), so the native handler creates the dated output directory,
// prints the connect diagnostic, then fails fast dialing. This exercises the real
// subprocess path — flag parse → resolution → mkdir → native connect — without the
// Go binary and without depending on a live database in CI.
const DEAD_DB_URL = "postgres://postgres:postgres@127.0.0.1:1/postgres";

// `--agent no` forces text-mode output deterministically (the CLI otherwise
// auto-selects JSON on stdout in a detected agent environment).
const TEXT_MODE = ["--agent", "no"];

describe("supabase inspect report (legacy)", () => {
  test(
    "creates the dated output directory and prints the connect diagnostic before failing on an unreachable database",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const outputDir = mkdtempSync(join(tmpdir(), "supabase-report-e2e-"));
      const { exitCode, stderr } = await runSupabase(
        ["inspect", "report", ...TEXT_MODE, "--db-url", DEAD_DB_URL, "--output-dir", outputDir],
        { entrypoint: "legacy", home: home.dir, env: { HOME: home.dir } },
      );
      expect(exitCode).toBe(1);
      // The native handler writes the connect diagnostic to stderr (Go parity).
      expect(stderr).toContain("Connecting to remote database...");
      expect(stderr).toMatch(/failed to connect to postgres|connection refused|ECONNREFUSED/i);
      // mkdir runs before the connection, so the dated folder exists even on failure.
      const dated = readdirSync(outputDir).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name));
      expect(dated.length).toBe(1);
      expect(existsSync(join(outputDir, dated[0]!))).toBe(true);
    },
  );
});
