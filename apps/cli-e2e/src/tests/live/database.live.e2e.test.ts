import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { testLiveRequires } from "./live-context.ts";

// DB-connectivity commands against the fresh project's Postgres via the IPv4
// session-mode Supavisor pooler (`dbUrl` from live-setup). The direct host
// (db.<ref>.supabase.red) is IPv6-only and unreachable from IPv4-only CI
// runners; the pooler is IPv4, and session mode is required for pg_dump.
// A non-zero exit here means the connection itself failed. All require the
// `database` capability (the project Postgres reachable over the pooler).
describe("database (live, session pooler --db-url)", () => {
  testLiveRequires(["database"])(
    "inspect db db-stats connects and reports stats",
    async ({ run, dbUrl }) => {
      const res = await run(["inspect", "db", "db-stats", "--db-url", dbUrl]);
      expect(res.exitCode, res.stderr).toBe(0);
      expect(res.stdout).toContain("Database Size");
    },
  );

  testLiveRequires(["database"])(
    "migration list connects to the remote migration history",
    async ({ run, dbUrl }) => {
      const res = await run(["migration", "list", "--db-url", dbUrl]);
      // Fresh project has no migrations, but exit 0 proves it connected and
      // queried the remote history table.
      expect(res.exitCode, res.stderr).toBe(0);
    },
  );

  // Also needs `docker`: without SUPABASE_DB_USE_LOCAL_TOOLS this `db dump` runs
  // pg_dump in a supabase/postgres container (see the C3 probe for the native path).
  testLiveRequires(["database", "docker"])(
    "db dump exports the remote schema",
    async ({ run, dbUrl, workspace }) => {
      const file = join(workspace.path, "dump.sql");
      const res = await run(["db", "dump", "--db-url", dbUrl, "-f", file]);
      expect(res.exitCode, res.stderr).toBe(0);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toMatch(/CREATE|PostgreSQL database dump|SCHEMA/i);
    },
  );
});
