import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { runSupabaseEffect, withTempHome } from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const TEST_TOKEN = "sbp_" + "a".repeat(40);

describe("supabase link", () => {
  // Golden-path surface test: in a real subprocess with no TTY, no --project-ref
  // and no SUPABASE_PROJECT_ID, ref resolution fails before any API call with the
  // cobra-style required-flag error. Validates dispatch + ref-resolution wiring
  // without needing a network fixture.
  it.live(
    "without a resolvable project ref exits 1 with the required-flag error",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const { exitCode, stdout, stderr } = yield* runSupabaseEffect(["link"], {
            home: home.dir,
            env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
          });
          expect(exitCode).toBe(1);
          expect(`${stdout}${stderr}`).toContain(`required flag(s) "project-ref" not set`);
        }),
      ),
    E2E_TIMEOUT_MS,
  );
});
