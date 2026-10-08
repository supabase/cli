import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { runSupabaseEffect, withTempHome } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase db branch (removed)", () => {
  it.live(
    "list exits 1 with the removal message and its replacement suggestion",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const { exitCode, stderr } = yield* runSupabaseEffect(["db", "branch", "list"], {
            home: home.dir,
            env: { HOME: home.dir },
          });

          expect(exitCode).toBe(1);
          expect(stderr).toContain("supabase db branch list was removed.");
          expect(stderr).toContain(
            "Local database branches are no longer supported. For hosted preview branches, see `supabase branches --help`.",
          );
        }),
      ),
    E2E_TIMEOUT_MS,
  );
});
