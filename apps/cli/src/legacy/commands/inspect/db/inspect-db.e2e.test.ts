import { describe, expect, test } from "vitest";

import { makeTempHome, runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

// A definitely-closed local port: resolution succeeds (the `--db-url` is parsed
// directly, no config.toml / running stack needed), then the native handler dials
// and fails fast with a connection error. This exercises the real subprocess path
// — flag parse → resolution → native query run — without the Go binary and without
// depending on a live database in CI.
const DEAD_DB_URL = "postgres://postgres:postgres@127.0.0.1:1/postgres";

// `--agent no` forces text-mode output deterministically: the CLI otherwise
// auto-selects a machine format (JSON on stdout) when it detects a coding-agent
// environment, which would route the error away from stderr.
const TEXT_MODE = "--agent";
const TEXT_MODE_VALUE = "no";

describe("supabase inspect db (legacy)", () => {
  test(
    "inspect db locks fails gracefully when the database is unreachable",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const { exitCode, stderr } = await runSupabase(
        ["inspect", "db", "locks", TEXT_MODE, TEXT_MODE_VALUE, "--db-url", DEAD_DB_URL],
        { entrypoint: "legacy", home: home.dir, env: { HOME: home.dir } },
      );
      expect(exitCode).toBe(1);
      // The native handler writes the connection diagnostic to stderr (Go parity)
      // and then surfaces the connection failure.
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
        { entrypoint: "legacy", home: home.dir, env: { HOME: home.dir } },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Command "cache-hit" is deprecated, use "db-stats" instead.');
      // The deprecation line precedes the connection diagnostic/error.
      const deprecationIndex = stderr.indexOf('Command "cache-hit" is deprecated');
      const connectingIndex = stderr.indexOf("Connecting to remote database...");
      expect(deprecationIndex).toBeGreaterThanOrEqual(0);
      expect(connectingIndex).toBeGreaterThan(deprecationIndex);
    },
  );
});
