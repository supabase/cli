import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { runSupabaseEffect } from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase completion", () => {
  // Only a real subprocess run proves the argv parser accepts --no-descriptions and the
  // handler selects the no-desc template variant.
  it.live(
    "bash --no-descriptions is accepted and produces the native no-descriptions script",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout } = yield* runSupabaseEffect(
          ["completion", "bash", "--no-descriptions"],
          {},
        );
        expect(exitCode).toBe(0);
        expect(stdout).toContain("__completeNoDesc");
      }),
    E2E_TIMEOUT_MS,
  );

  // Smoke-tests the default code path end-to-end for a shell other than bash.
  it.live(
    "zsh with no flags produces the native default script",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout } = yield* runSupabaseEffect(["completion", "zsh"], {});
        expect(exitCode).toBe(0);
        expect(stdout).toContain("#compdef supabase");
        expect(stdout).toContain("__complete");
      }),
    E2E_TIMEOUT_MS,
  );
});
