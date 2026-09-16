import { describe, expect, test } from "vitest";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- e2e fixture appends experimental.stack to project config
import { appendFile, readdir } from "node:fs/promises";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- e2e fixture joins project and cache paths
import path from "node:path";

import { makeTempHome, makeTempStackProject, runSupabase } from "../../../../tests/helpers/cli.ts";

const DB_START_COMMAND_TIMEOUT_MS = 480_000;
const DB_START_CLEANUP_TIMEOUT_MS = 120_000;
const STACK_DB_AUX_TIMEOUT_MS = 180_000;
const STACK_DIFF_TIMEOUT_MS = 180_000;
const STACK_DIFF_TEST_TIMEOUT_MS =
  DB_START_COMMAND_TIMEOUT_MS +
  STACK_DB_AUX_TIMEOUT_MS +
  STACK_DIFF_TIMEOUT_MS +
  DB_START_CLEANUP_TIMEOUT_MS;

const STACK_BASELINE_TAR = /^stack-shadow-baseline-[0-9a-f]{16}\.tar$/u;
const COMPOSE_BASELINE_TAR = /^shadow-baseline-[0-9a-f]{16}\.tar$/u;
const PROBE_FN_SQL = /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+"?public"?\s*\.\s*"?probe_fn"?\s*\(\)/i;

describe("supabase db diff (e2e, stack shadow)", () => {
  test(
    "stack db diff --local publishes a stack-shadow-baseline tar",
    async () => {
      const home = makeTempHome();
      const project = await makeTempStackProject("supabase-db-diff-stack-e2e-");
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

        const createFunction = await runSupabase(
          [
            "db",
            "query",
            `create function public.probe_fn()
returns void
language sql
as $$ select 1; $$;`,
            "--local",
          ],
          { cwd: project.dir, home: home.dir, exitTimeoutMs: STACK_DB_AUX_TIMEOUT_MS },
        );
        expect(createFunction.exitCode, createFunction.stderr).toBe(0);

        const diff = await runSupabase(["db", "diff", "--local", "--use-pg-delta"], {
          cwd: project.dir,
          home: home.dir,
          exitTimeoutMs: STACK_DIFF_TIMEOUT_MS,
          env: { SUPABASE_SHADOW_CACHE: undefined },
        });
        expect(diff.exitCode, `${diff.stdout}\n${diff.stderr}`).toBe(0);
        expect(diff.stdout).toMatch(PROBE_FN_SQL);

        const cacheDir = path.join(home.dir, "cache", "shadow-baseline");
        const entries = await readdir(cacheDir).catch(() => [] as Array<string>);
        expect(entries.filter((entry) => STACK_BASELINE_TAR.test(entry))).toHaveLength(1);
        expect(entries.filter((entry) => COMPOSE_BASELINE_TAR.test(entry))).toHaveLength(0);
        expect(entries.filter((entry) => entry.endsWith(".partial"))).toHaveLength(0);
      } finally {
        await runSupabase(["stack", "destroy", "--yes"], {
          cwd: project.dir,
          home: home.dir,
          env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
          exitTimeoutMs: DB_START_CLEANUP_TIMEOUT_MS,
        }).catch(() => undefined);
      }
    },
    STACK_DIFF_TEST_TIMEOUT_MS,
  );
});
