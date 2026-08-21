import { expect } from "vitest";

import { describeLocalStackLive } from "../../../../../tests/helpers/live.ts";
import { testLive } from "../../../../../tests/helpers/live-context.ts";

describeLocalStackLive("supabase db start (live)", () => {
  testLive(
    "boots the local database",
    async ({ run }) => {
      try {
        const started = await run(["db", "start"]);
        expect(started.exitCode, started.stderr).toBe(0);
        expect(`${started.stdout}${started.stderr}`).toMatch(
          /Starting database|Initialising schema/i,
        );
      } finally {
        await run(["stop", "--no-backup"]).catch(() => undefined);
      }
    },
    600_000,
  );
});
