import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";

import { assertSeedTargetsExclusive } from "./buckets.flags.ts";

describe("assertSeedTargetsExclusive", () => {
  it("fails when both --local and --linked are set (mutual exclusivity)", () => {
    const exit = Effect.runSyncExit(
      assertSeedTargetsExclusive(["seed", "buckets", "--local", "--linked"]),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain(
      "if any flags in the group [local linked] are set none of the others can be; [linked local] were all set",
    );
  });

  it("fails for the --no-local --linked negation combo (both changed)", () => {
    const exit = Effect.runSyncExit(
      assertSeedTargetsExclusive(["seed", "buckets", "--no-local", "--linked"]),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("[linked local] were all set");
  });

  it("succeeds when at most one target flag is set", () => {
    for (const args of [
      ["seed", "buckets", "--linked"],
      ["seed", "buckets", "--local"],
      ["seed", "buckets"],
    ]) {
      expect(Exit.isSuccess(Effect.runSyncExit(assertSeedTargetsExclusive(args)))).toBe(true);
    }
  });
});
