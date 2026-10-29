import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { runSupabaseEffect, withTempHome } from "../../../../tests/helpers/cli.ts";

import { FEEDBACK_EMPTY_MESSAGE } from "./add.errors.ts";

const E2E_TIMEOUT_MS = 60_000;

describe("supabase feedback", () => {
  // Subcommand routing through the real parser is the only surface handler
  // integration tests can't reach. The empty-message path proves it with zero
  // network: no args, whitespace-only piped stdin, non-TTY — the command exits
  // 1 before any request could leave the process. The real-backend golden path
  // (add → delete round trip) lives in add.live.test.ts, gated to the
  // cli-e2e-ci runner.
  it.live(
    "feedback add fails with the empty-message error when nothing is provided",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const result = yield* runSupabaseEffect(["feedback", "add"], {
            home: home.dir,
            env: { HOME: home.dir },
            stdin: "   \n",
          });
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain(FEEDBACK_EMPTY_MESSAGE);
          expect(result.stdout).toBe("");
        }),
      ),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "feedback add rejects more than 3 --target flags before running",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const target = '{"url":"https://supabase.com/docs/guides/auth","quote":"a"}';
          const result = yield* runSupabaseEffect(
            [
              "feedback",
              "add",
              ...Array.from({ length: 4 }, () => ["--target", target]).flat(),
              "docs gap",
            ],
            { home: home.dir, env: { HOME: home.dir } },
          );
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain("at most 3");
          expect(result.stdout).toBe("");
        }),
      ),
    E2E_TIMEOUT_MS,
  );
});
