import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { assertSeedTargetsExclusive, seedChangedTargetFlags } from "./buckets.flags.ts";

describe("seedChangedTargetFlags", () => {
  it("returns both selectors in cobra's sorted order when both are set", () => {
    expect(seedChangedTargetFlags(["seed", "buckets", "--local", "--linked"])).toEqual([
      "linked",
      "local",
    ]);
  });

  it("returns a single selector", () => {
    expect(seedChangedTargetFlags(["seed", "buckets", "--linked"])).toEqual(["linked"]);
    expect(seedChangedTargetFlags(["seed", "buckets", "--local"])).toEqual(["local"]);
  });

  it("returns nothing when neither is set", () => {
    expect(seedChangedTargetFlags(["seed", "buckets"])).toEqual([]);
  });

  it("does not treat a value-consuming flag's value as a selector", () => {
    expect(seedChangedTargetFlags(["seed", "buckets", "--workdir", "--linked"])).toEqual([]);
  });

  it("skips the value token after a short value-consuming flag", () => {
    expect(seedChangedTargetFlags(["-o", "--linked", "--local"])).toEqual(["local"]);
  });

  it("stops scanning at the -- terminator", () => {
    expect(seedChangedTargetFlags(["seed", "buckets", "--", "--local", "--linked"])).toEqual([]);
  });

  it("handles = forms", () => {
    expect(seedChangedTargetFlags(["--local=true", "--linked=false"])).toEqual(["linked", "local"]);
  });

  it("treats the --no-* negation form as changed (Effect CLI boolean negation)", () => {
    expect(seedChangedTargetFlags(["seed", "buckets", "--no-linked"])).toEqual(["linked"]);
    expect(seedChangedTargetFlags(["seed", "buckets", "--no-local"])).toEqual(["local"]);
    expect(seedChangedTargetFlags(["seed", "buckets", "--no-local", "--linked"])).toEqual([
      "linked",
      "local",
    ]);
  });
});

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
