import { describe, expect } from "vitest";
import { testLive } from "./live-context.ts";

// SKIPPED in CI — IPv6 connectivity issue.
//
// These commands connect to the fresh project's Postgres via a direct --db-url
// (db.<ref>.supabase.red), which resolves to an IPv6-only address. GitHub /
// Blacksmith runners are IPv4-only, so the connection fails with
// "no route to host". A direct --db-url has no pooler fallback (that only
// happens in --linked mode), so it cannot recover on an IPv4-only host.
//
// They pass locally (where IPv6 is available) and are kept here as the ready
// shape for the DB-connectivity matrix. Re-enabling them in CI requires routing
// through the IPv4 session-mode Supavisor pooler — tracked as a follow-up.
// (db dump and gen types were dropped entirely: pg_dump needs the session-mode
// pooler specifically, and gen types additionally needs a Docker image pull.)
describe.skip("database (live --db-url) [skipped: IPv6-only direct host]", () => {
  testLive("inspect db db-stats connects and reports stats", async ({ run, dbUrl }) => {
    const res = await run(["inspect", "db", "db-stats", "--db-url", dbUrl]);
    expect(res.exitCode, res.stderr).toBe(0);
    expect(res.stdout).toContain("Database Size");
  });

  testLive("migration list connects to the remote migration history", async ({ run, dbUrl }) => {
    const res = await run(["migration", "list", "--db-url", dbUrl]);
    // Fresh project has no migrations, but exit 0 proves the command connected
    // and queried the remote history table.
    expect(res.exitCode, res.stderr).toBe(0);
  });
});
