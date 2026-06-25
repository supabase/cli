import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { makeTempHome, runSupabase } from "../../../../tests/helpers/cli.ts";

/**
 * Real-stack live e2e for the native `db start` / `db reset --local` ports — the
 * one boundary the integration suites mock (the `db __db-bootstrap` Go seam +
 * real Docker). It boots an actual local Postgres container, so it is **opt-in**:
 * gated behind `SUPABASE_E2E_DOCKER=1` and skipped by default (it must NOT run in
 * the normal feedback loop / CI e2e default — booting + pulling images is slow).
 *
 * Run locally with a working Docker daemon:
 *   pnpm build:go-sidecar && pnpm build:legacy && pnpm build:shim
 *   SUPABASE_E2E_DOCKER=1 bun --bun ./node_modules/vitest/vitest.mjs run \
 *     --project e2e src/legacy/commands/db/db-local-stack.live.e2e.test.ts
 *
 * Tests share one stack and run in declaration order (the e2e project is
 * sequential); `afterAll` tears the stack down even on failure.
 */
const dockerEnabled = process.env["SUPABASE_E2E_DOCKER"] === "1";

// First `db start` pulls the Postgres + service images; subsequent ops are fast.
const START_TIMEOUT_MS = 600_000;
const RESET_TIMEOUT_MS = 180_000;

describe.skipIf(!dockerEnabled)("db start / db reset --local (live, real Docker)", () => {
  let projectDir: string;
  let home: ReturnType<typeof makeTempHome>;

  beforeAll(async () => {
    home = makeTempHome();
    projectDir = mkdtempSync(join(tmpdir(), "supabase-db-local-stack-e2e-"));
    // `init` writes a full default config.toml (db image, ports, services).
    const init = await runSupabase(["init"], {
      entrypoint: "legacy",
      cwd: projectDir,
      home: home.dir,
      exitTimeoutMs: 60_000,
    });
    expect(init.exitCode, init.stderr).toBe(0);
  }, 120_000);

  afterAll(async () => {
    // Tear the stack down (legacy proxies `stop` to the Go binary) even if a
    // test failed, then drop the temp project. HOME is cleaned by the harness.
    if (projectDir !== undefined) {
      await runSupabase(["stop", "--no-backup"], {
        entrypoint: "legacy",
        cwd: projectDir,
        home: home.dir,
        exitTimeoutMs: 120_000,
      }).catch(() => undefined);
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 180_000);

  test("db start boots the local Postgres container", { timeout: START_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabase(["db", "start"], {
      entrypoint: "legacy",
      cwd: projectDir,
      home: home.dir,
      exitTimeoutMs: START_TIMEOUT_MS,
    });
    expect(exitCode, stderr).toBe(0);
    // The Go seam tees bootstrap progress to stderr (mode-independent).
    expect(`${stdout}${stderr}`).toContain("Starting database");
  });

  test(
    "db start is a no-op (exit 0) when already running",
    { timeout: RESET_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(["db", "start"], {
        entrypoint: "legacy",
        cwd: projectDir,
        home: home.dir,
        exitTimeoutMs: RESET_TIMEOUT_MS,
      });
      expect(exitCode).toBe(0);
      // text mode → stderr line; agent mode → stdout JSON status. Match either.
      expect(`${stdout}${stderr}`).toMatch(/already[\s-]running/i);
    },
  );

  test(
    "db reset --local recreates the database and prints the branch line",
    { timeout: RESET_TIMEOUT_MS },
    async () => {
      const { exitCode, stderr } = await runSupabase(["db", "reset", "--local"], {
        entrypoint: "legacy",
        cwd: projectDir,
        home: home.dir,
        exitTimeoutMs: RESET_TIMEOUT_MS,
      });
      expect(exitCode, stderr).toBe(0);
      // "Finished supabase db reset on branch <branch>." goes to stderr (ANSI-wrapped).
      expect(stderr).toContain("on branch ");
    },
  );
});
