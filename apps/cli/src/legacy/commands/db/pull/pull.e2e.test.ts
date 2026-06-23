import { describe, expect, test } from "vitest";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase db pull (legacy)", () => {
  // Docker-free golden-path: the `--declarative` / `--diff-engine` mutual-exclusion
  // is validated before any connection or shadow work, so this exits non-zero
  // through a real subprocess without Docker.
  test(
    "--declarative with --diff-engine exits non-zero (mutually exclusive)",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode } = await runSupabase(
        ["db", "pull", "--declarative", "--diff-engine", "migra"],
        { entrypoint: "legacy" },
      );
      expect(exitCode).not.toBe(0);
    },
  );
});
