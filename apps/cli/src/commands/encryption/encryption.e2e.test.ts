import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { runSupabaseEffect } from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const TEST_TOKEN = "sbp_" + "a".repeat(40);

describe("supabase encryption", () => {
  it.live(
    "get-root-key without a resolvable project ref exits non-zero with the not-linked message",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["encryption", "get-root-key"],
          { env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
        );
        expect(exitCode).not.toBe(0);
        expect(`${stdout}${stderr}`).toContain("Cannot find project ref");
      }),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "update-root-key with piped key but no resolvable ref exits non-zero",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["encryption", "update-root-key"],
          { env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN }, stdin: "newkey\n" },
        );
        expect(exitCode).not.toBe(0);
        expect(`${stdout}${stderr}`).toContain("Cannot find project ref");
      }),
    E2E_TIMEOUT_MS,
  );
});
