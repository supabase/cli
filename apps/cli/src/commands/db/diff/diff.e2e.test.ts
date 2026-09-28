import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase db diff", () => {
  // Docker-free golden-path: the explicit-mode flag validation runs before any
  // shadow/Docker work, so `--from` without `--to` exits non-zero with the
  // established error message through a real subprocess.
  it.live(
    "--from without --to exits non-zero with the explicit-mode error",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["db", "diff", "--from", "local"],
          {},
        );
        expect(exitCode).not.toBe(0);
        expect(`${stdout}${stderr}`).toContain(
          "must set both --from and --to when using explicit diff mode",
        );
      }),
    E2E_TIMEOUT_MS,
  );
});
