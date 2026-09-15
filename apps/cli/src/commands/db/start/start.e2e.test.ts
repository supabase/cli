import { describe, expect, test } from "vitest";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- e2e fixture appends experimental.stack to project config
import { appendFile } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- e2e fixture joins project paths
import path from "node:path";

import { makeTempHome, makeTempStackProject, runSupabase } from "../../../../tests/helpers/cli.ts";

const DB_START_COMMAND_TIMEOUT_MS = 480_000;
const DB_START_CLEANUP_TIMEOUT_MS = 120_000;
const DB_START_TEST_TIMEOUT_MS = DB_START_COMMAND_TIMEOUT_MS + DB_START_CLEANUP_TIMEOUT_MS;
const STACK_DB_AUX_TIMEOUT_MS = 180_000;
const STACK_DB_TEST_TIMEOUT_MS =
  DB_START_COMMAND_TIMEOUT_MS * 2 + STACK_DB_AUX_TIMEOUT_MS + DB_START_CLEANUP_TIMEOUT_MS;

describe("supabase db start (e2e)", () => {
  test(
    "boots the local database",
    async () => {
      const home = makeTempHome();
      const project = await makeTempStackProject("supabase-db-start-e2e-");
      try {
        const started = await runSupabase(["db", "start"], {
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
          cwd: project.dir,
          home: home.dir,
          exitTimeoutMs: DB_START_CLEANUP_TIMEOUT_MS,
        }).catch(() => undefined);
      }
    },
    DB_START_TEST_TIMEOUT_MS,
  );

  test(
    "stack db start serves --local consumers and rejects migra",
    async () => {
      const home = makeTempHome();
      const project = await makeTempStackProject("supabase-db-start-stack-e2e-");
      await appendFile(
        path.join(project.dir, "supabase", "config.toml"),
        "\n[experimental]\nstack = true\n",
      );
      try {
        const started = await runSupabase(["db", "start"], {
          cwd: project.dir,
          home: home.dir,
          exitTimeoutMs: DB_START_COMMAND_TIMEOUT_MS,
        });
        expect(started.exitCode, started.stderr).toBe(0);

        const types = await runSupabase(["gen", "types", "--local"], {
          cwd: project.dir,
          home: home.dir,
          exitTimeoutMs: STACK_DB_AUX_TIMEOUT_MS,
        });
        expect(types.exitCode, types.stderr).toBe(0);

        const reset = await runSupabase(["db", "reset", "--local", "--no-seed", "--yes"], {
          cwd: project.dir,
          home: home.dir,
          exitTimeoutMs: DB_START_COMMAND_TIMEOUT_MS,
        });
        expect(reset.exitCode, reset.stderr).toBe(0);

        const diff = await runSupabase(["db", "diff", "--local", "--use-migra"], {
          cwd: project.dir,
          home: home.dir,
          exitTimeoutMs: STACK_DB_AUX_TIMEOUT_MS,
        });
        expect(diff.exitCode, diff.stderr).not.toBe(0);
        expect(`${diff.stdout}${diff.stderr}`).toContain("pg-delta engine");
      } finally {
        await runSupabase(["stop", "--no-backup"], {
          cwd: project.dir,
          home: home.dir,
          exitTimeoutMs: DB_START_CLEANUP_TIMEOUT_MS,
        }).catch(() => undefined);
      }
    },
    STACK_DB_TEST_TIMEOUT_MS,
  );
});
