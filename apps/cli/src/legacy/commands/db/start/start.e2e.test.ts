// oxlint-disable effecttsgo/async-function -- this e2e test uses Vitest's Promise surface to drive the real CLI.
import { describe, expect, test } from "vitest";

import {
  makeTempHome,
  makeTempStackProject,
  runSupabase,
} from "../../../../../tests/helpers/cli.ts";

const DB_START_COMMAND_TIMEOUT_MS = 480_000;
const DB_START_CLEANUP_TIMEOUT_MS = 120_000;
const DB_START_TEST_TIMEOUT_MS = DB_START_COMMAND_TIMEOUT_MS + DB_START_CLEANUP_TIMEOUT_MS;

describe("supabase db start (e2e)", () => {
  test(
    "boots the local database",
    async () => {
      const home = makeTempHome();
      const project = await makeTempStackProject("supabase-db-start-e2e-");
      try {
        const started = await runSupabase(["db", "start"], {
          entrypoint: "legacy",
          cwd: project.dir,
          home: home.dir,
          exitTimeoutMs: DB_START_COMMAND_TIMEOUT_MS,
        });
        expect(started.exitCode, started.stderr).toBe(0);
        expect(`${started.stdout}${started.stderr}`).toMatch(
          /Starting database|Initialising schema/i,
        );
      } finally {
        await runSupabase(["stop", "--no-backup"], {
          entrypoint: "legacy",
          cwd: project.dir,
          home: home.dir,
          exitTimeoutMs: DB_START_CLEANUP_TIMEOUT_MS,
        }).catch(() => undefined);
      }
    },
    DB_START_TEST_TIMEOUT_MS,
  );
});
