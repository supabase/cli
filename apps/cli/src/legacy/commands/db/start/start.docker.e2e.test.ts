import { describe, expect, test } from "vitest";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

describe("supabase db start (e2e)", () => {
  test("boots the local database", async () => {
    try {
      const started = await runSupabase(["db", "start"]);
      expect(started.exitCode, started.stderr).toBe(0);
      expect(`${started.stdout}${started.stderr}`).toMatch(
        /Starting database|Initialising schema/i,
      );
    } finally {
      await runSupabase(["stop", "--no-backup"]).catch(() => undefined);
    }
  }, 600_000);
});
