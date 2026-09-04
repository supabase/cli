import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runSupabase, stripAnsi } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase start (legacy)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "sb-start-e2e-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  // Golden-path smoke test for the real subprocess boundary: exclude-flag
  // validation runs unconditionally as the handler's very first step, before
  // config load or any Docker access, so an invalid `--exclude` value must
  // print the `WARNING:` text regardless of what happens afterwards. No
  // `supabase/config.toml` is seeded — an absent config is not itself a
  // failure, the command proceeds with defaults — so the command runs past
  // config loading and reaches a real Docker call, which this test
  // forces to fail fast and deterministically via an unreachable `DOCKER_HOST` rather than
  // relying on whether a real Docker daemon happens to be reachable in the sandbox: with a
  // real daemon this pins the test to a fast, predictable failure instead of a slow real
  // image pull; without one it fails just as fast because `docker`/`podman` can't be
  // spawned at all. Either way the command must still exit non-zero cleanly after printing
  // the warning — this is the only invariant asserted, not which downstream error fires.
  test(
    "prints the invalid --exclude warning then fails cleanly on the Docker call",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(["start", "--exclude", "bogus"], {
        entrypoint: "legacy",
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
