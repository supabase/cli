import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { testLive } from "./live-context.ts";

// Local↔remote schema sync (workflows 1-2) over the IPv4 session pooler. Done as
// one round-trip in a single workspace: pushing first makes the local migration
// history match the remote, so the subsequent pull's consistency check passes
// (a separate fresh-workspace pull would see a history mismatch on the shared
// per-run project). db push/pull confirm via a prompt that only auto-accepts
// with --yes. Mutates the throwaway project's schema — deleted on teardown.
describe("db push + pull (live, session pooler)", () => {
  testLive(
    "pushes a local migration and pulls the remote schema back",
    async ({ run, dbUrl, workspace }) => {
      const migrations = join(workspace.path, "supabase", "migrations");
      mkdirSync(migrations, { recursive: true });
      writeFileSync(
        join(migrations, "20240101000000_e2e_push.sql"),
        "create table if not exists e2e_push (id int);\n",
      );

      const pushed = await run(["db", "push", "--db-url", dbUrl, "--yes"]);
      expect(pushed.exitCode, pushed.stderr).toBe(0);

      const listed = await run(["migration", "list", "--db-url", dbUrl]);
      expect(listed.exitCode, listed.stderr).toBe(0);
      expect(listed.stdout).toContain("20240101000000");

      // Local history now matches remote, so pull connects and runs the diff.
      // It either finds a remote-only change (exit 0, writes a migration) or
      // reports no changes — both prove connectivity; only a real connection
      // failure would surface a different error.
      const pulled = await run(["db", "pull", "--db-url", dbUrl, "--yes"]);
      const pullOutput = `${pulled.stdout}${pulled.stderr}`;
      // The point of this test is connectivity over the pooler: a real connection
      // failure must never be mistaken for a benign "no changes" outcome.
      expect(pullOutput, "db pull hit a connection error").not.toMatch(
        /dial|no route|connection refused|could not connect|server closed the connection|i\/o timeout/i,
      );
      expect(
        pulled.exitCode === 0 || /No schema changes found/i.test(pullOutput),
        pulled.stderr,
      ).toBe(true);
    },
  );
});
