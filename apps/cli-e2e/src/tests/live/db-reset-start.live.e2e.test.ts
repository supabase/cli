import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { TARGET } from "../env.ts";
import { testLive } from "./live-context.ts";

// Real-backend live coverage for the native `db start` / `db reset` ports.
//
// `db start` / `db reset` live only in the `go` reference and the `ts-legacy`
// port (the `next` shell has no `db` group), so skip the `ts-next` target.
//
// The live suite runs serially (`fileParallelism: false`, `maxWorkers: 1`), so the
// destructive remote reset below is safe against the throwaway per-run project.

// --- Local leg: db start + db reset --local against the real Docker socket -----
// Exercises the hidden `db __db-bootstrap` Go seam end-to-end — the boundary the
// in-process integration suites mock. The start → already-running → reset cycle
// runs in one test so it shares a single booted stack, and `finally` stops it
// (legacy proxies `stop` to Go) so the run never leaves containers behind.
describe.skipIf(TARGET === "ts-next")("db start / db reset --local (live, local Docker)", () => {
  testLive(
    "db start boots, is idempotent, and db reset --local recreates",
    { timeout: 600_000 },
    async ({ run }) => {
      try {
        const start = await run(["db", "start"]);
        expect(start.exitCode, start.stderr).toBe(0);
        // Go tees bootstrap progress to stderr (mode-independent).
        expect(`${start.stdout}${start.stderr}`).toMatch(/Starting database|Initialising schema/i);

        // Second start is a no-op: the db is already running, exit 0.
        const again = await run(["db", "start"]);
        expect(again.exitCode, again.stderr).toBe(0);
        expect(`${again.stdout}${again.stderr}`).toMatch(/already[\s-]running/i);

        // Local reset recreates the container and prints the git-branch line.
        const reset = await run(["db", "reset", "--local"]);
        expect(reset.exitCode, reset.stderr).toBe(0);
        expect(reset.stderr).toContain("on branch ");
      } finally {
        await run(["stop", "--no-backup"]).catch(() => undefined);
      }
    },
  );
});

// --- Remote leg: db reset against the staging project over the session pooler ---
// Exercises the native remote reset path (drop user schemas → apply local
// migrations → seed) against a real Postgres, no Docker. `--yes` auto-accepts the
// confirmation prompt (the non-interactive default is decline). Mutates the
// throwaway project's schema — deleted on teardown. The IPv4 session pooler
// `dbUrl` is used because the direct host is IPv6-only and unreachable from
// IPv4-only CI runners.
describe.skipIf(TARGET === "ts-next")("db reset (live, remote session pooler)", () => {
  testLive(
    "resets the remote schema and re-applies a local migration",
    { timeout: 600_000 },
    async ({ run, dbUrl, workspace }) => {
      const migrations = join(workspace.path, "supabase", "migrations");
      mkdirSync(migrations, { recursive: true });
      writeFileSync(
        join(migrations, "20240101000000_e2e_reset.sql"),
        "create table if not exists e2e_reset (id int);\n",
      );

      const reset = await run(["db", "reset", "--db-url", dbUrl, "--yes"]);
      expect(reset.exitCode, reset.stderr).toBe(0);
      expect(reset.stderr).toContain("Resetting remote database");
      // A real connection failure must never be mistaken for a benign outcome.
      expect(`${reset.stdout}${reset.stderr}`, "db reset hit a connection error").not.toMatch(
        /dial|no route|connection refused|could not connect|server closed the connection|i\/o timeout/i,
      );

      // The migration history shows the re-applied version → proves the drop +
      // migrate ran against the remote database.
      const listed = await run(["migration", "list", "--db-url", dbUrl]);
      expect(listed.exitCode, listed.stderr).toBe(0);
      expect(listed.stdout).toContain("20240101000000");
    },
  );
});
