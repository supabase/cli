import { describe, expect, test } from "vitest";

import { makeTempHome, runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

// A definitely-closed local port: `--db-url` resolves without a config.toml or running
// stack, then the native handler dials and fails fast — exercising the real subprocess path
// without depending on a live database in CI.
const DEAD_DB_URL = "postgres://postgres:postgres@127.0.0.1:1/postgres";

// `--agent no` forces text-mode output; otherwise the CLI may auto-select a machine format
// (JSON on stdout) in a detected coding-agent environment, routing the error away from stderr.
const TEXT_MODE = "--agent";
const TEXT_MODE_VALUE = "no";

describe("supabase inspect db", () => {
  test(
    "inspect db locks fails gracefully when the database is unreachable",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const { exitCode, stderr } = await runSupabase(
        ["inspect", "db", "locks", TEXT_MODE, TEXT_MODE_VALUE, "--db-url", DEAD_DB_URL],
        { home: home.dir, env: { HOME: home.dir } },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Connecting to remote database...");
      expect(stderr).toMatch(/failed to connect to postgres|connection refused|ECONNREFUSED/i);
    },
  );

  test(
    "inspect db cache-hit prints the deprecation notice before the connection error",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const { exitCode, stderr } = await runSupabase(
        ["inspect", "db", "cache-hit", TEXT_MODE, TEXT_MODE_VALUE, "--db-url", DEAD_DB_URL],
        { home: home.dir, env: { HOME: home.dir } },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Command "cache-hit" is deprecated, use "db-stats" instead.');
      const deprecationIndex = stderr.indexOf('Command "cache-hit" is deprecated');
      const connectingIndex = stderr.indexOf("Connecting to remote database...");
      expect(deprecationIndex).toBeGreaterThanOrEqual(0);
      expect(connectingIndex).toBeGreaterThan(deprecationIndex);
    },
  );
});
