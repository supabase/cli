import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase db pull", () => {
  // Docker-free golden-path: the `--declarative` / `--diff-engine` mutual-exclusion
  // is validated before any connection or shadow work, so this exits non-zero
  // through a real subprocess without Docker.
  it.live(
    "--declarative with --diff-engine exits non-zero (mutually exclusive)",
    () =>
      Effect.gen(function* () {
        const { exitCode } = yield* runSupabaseEffect([
          "db",
          "pull",
          "--declarative",
          "--diff-engine",
          "migra",
        ]);
        expect(exitCode).not.toBe(0);
      }),
    E2E_TIMEOUT_MS,
  );
});
