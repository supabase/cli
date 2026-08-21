import { describe, expect, test } from "vitest";

import {
  makeTempHome,
  makeTempStackProject,
  runSupabase,
} from "../../../../../tests/helpers/cli.ts";

describe("supabase db start (e2e)", () => {
  test("boots the local database", async () => {
    const home = makeTempHome();
    const project = await makeTempStackProject("supabase-db-start-e2e-");
    try {
      const started = await runSupabase(["db", "start"], {
        cwd: project.dir,
        home: home.dir,
      });
      expect(started.exitCode, started.stderr).toBe(0);
      expect(`${started.stdout}${started.stderr}`).toMatch(
        /Starting database|Initialising schema/i,
      );
    } finally {
      await runSupabase(["stop", "--no-backup"], {
        cwd: project.dir,
        home: home.dir,
      }).catch(() => undefined);
    }
  }, 600_000);
});
