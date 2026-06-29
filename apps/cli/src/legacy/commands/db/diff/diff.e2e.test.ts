import { describe, expect, test } from "vitest";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase db diff (legacy)", () => {
  // Docker-free golden-path: the explicit-mode flag validation runs before any
  // shadow/Docker work, so `--from` without `--to` exits non-zero with Go's exact
  // message through a real subprocess.
  test(
    "--from without --to exits non-zero with the explicit-mode error",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(["db", "diff", "--from", "local"], {
        entrypoint: "legacy",
      });
      expect(exitCode).not.toBe(0);
      expect(`${stdout}${stderr}`).toContain(
        "must set both --from and --to when using explicit diff mode",
      );
    },
  );
});
