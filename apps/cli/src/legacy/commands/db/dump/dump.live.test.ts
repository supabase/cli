import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import {
  describeLiveDataPlane,
  requireLiveProjectRef,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 300_000;

// A fresh, isolated temp workdir so the CLI writes the dump there and never touches
// the repo tree. The provisioned project ref is supplied to `--linked` via the
// `SUPABASE_PROJECT_ID` env var — that is the `--linked` resolver chain in both Go
// and the legacy port (flag → `SUPABASE_PROJECT_ID` → `supabase/.temp/project-ref`);
// `config.toml`'s `project_id` is NOT consulted for `--linked`.
function tempWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "sb-db-dump-live-"));
}

// Data-plane: needs a provisioned project whose database is routable (the
// cli-e2e-ci Linux runner). `describeLiveDataPlane` runs this only when the project
// instance is ACTIVE_HEALTHY, so a control-plane-only stack (ref set but the DB
// unreachable, e.g. local macOS or the current cli-e2e-ci control-plane case) is
// skipped rather than timing out on pg_dump.
describeLiveDataPlane("supabase db dump (live)", () => {
  test("dumps the linked project's schema to a file", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const ref = requireLiveProjectRef();
    const dir = tempWorkdir();
    try {
      const outFile = join(dir, "schema.sql");
      const { exitCode, stdout, stderr } = await runSupabaseLive(
        ["db", "dump", "--linked", "-f", outFile],
        { cwd: dir, env: { SUPABASE_PROJECT_ID: ref }, exitTimeoutMs: LIVE_TIMEOUT_MS - 20_000 },
      );
      expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
      expect(exitCode).toBe(0);
      // The native pg_dump container (shared `legacyStreamPgDump`) opened + wrote
      // the dump file. A fresh project's public schema may be near-empty, so assert
      // the file was created rather than its size.
      expect(existsSync(outFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
