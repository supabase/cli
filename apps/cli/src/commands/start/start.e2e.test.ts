import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runSupabase, stripAnsi } from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase start", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "sb-start-e2e-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  // An unreachable `DOCKER_HOST` forces a fast, deterministic failure regardless of whether a
  // real Docker daemon is reachable in the sandbox.
  test(
    "prints the invalid --exclude warning then fails cleanly on the Docker call",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(["start", "--exclude", "bogus"], {
        cwd: projectDir,
        env: { DOCKER_HOST: "tcp://127.0.0.1:1" },
      });

      expect(stripAnsi(stderr), `stdout:\n${stdout}\nstderr:\n${stderr}`).toContain(
        "WARNING: The following container names are not valid to exclude: bogus",
      );
      expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).not.toBe(0);
    },
  );
});
