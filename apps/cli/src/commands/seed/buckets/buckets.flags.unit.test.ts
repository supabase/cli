import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { assertSeedTargetsExclusive } from "./buckets.flags.ts";

describe("assertSeedTargetsExclusive", () => {
  it.effect("fails when both --local and --linked are set (cobra mutual exclusivity)", () =>
    Effect.gen(function* () {
      const error = yield* assertSeedTargetsExclusive([
        "seed",
        "buckets",
        "--local",
        "--linked",
      ]).pipe(Effect.flip);
      expect(error.message).toBe(
        "if any flags in the group [local linked] are set none of the others can be; [linked local] were all set",
      );
    }),
  );

  it.effect("fails for the --no-local --linked negation combo (both changed)", () =>
    Effect.gen(function* () {
      const error = yield* assertSeedTargetsExclusive([
        "seed",
        "buckets",
        "--no-local",
        "--linked",
      ]).pipe(Effect.flip);
      expect(error.message).toContain("[linked local] were all set");
    }),
  );

  it.effect("succeeds when at most one target flag is set", () =>
    Effect.gen(function* () {
      for (const args of [
        ["seed", "buckets", "--linked"],
        ["seed", "buckets", "--local"],
        ["seed", "buckets"],
      ]) {
        const exit = yield* assertSeedTargetsExclusive(args).pipe(Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
      }
    }),
  );
});
