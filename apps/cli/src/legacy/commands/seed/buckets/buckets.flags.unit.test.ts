import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";

import { legacyAssertSeedTargetsExclusive, legacySeedChangedTargetFlags } from "./buckets.flags.ts";

describe("legacySeedChangedTargetFlags", () => {
  it("returns both selectors in cobra's sorted order when both are set", () => {
    expect(legacySeedChangedTargetFlags(["seed", "buckets", "--local", "--linked"])).toEqual([
      "linked",
      "local",
    ]);
  });

  it("returns a single selector", () => {
    expect(legacySeedChangedTargetFlags(["seed", "buckets", "--linked"])).toEqual(["linked"]);
    expect(legacySeedChangedTargetFlags(["seed", "buckets", "--local"])).toEqual(["local"]);
  });

  it("returns nothing when neither is set", () => {
    expect(legacySeedChangedTargetFlags(["seed", "buckets"])).toEqual([]);
  });

  it("does not treat a value-consuming flag's value as a selector", () => {
    expect(legacySeedChangedTargetFlags(["seed", "buckets", "--workdir", "--linked"])).toEqual([]);
  });

  it("skips the value token after a short value-consuming flag", () => {
    expect(legacySeedChangedTargetFlags(["-o", "--linked", "--local"])).toEqual(["local"]);
  });

  it("stops scanning at the -- terminator", () => {
    expect(legacySeedChangedTargetFlags(["seed", "buckets", "--", "--local", "--linked"])).toEqual(
      [],
    );
  });

  it("handles = forms", () => {
    expect(legacySeedChangedTargetFlags(["--local=true", "--linked=false"])).toEqual([
      "linked",
      "local",
    ]);
  });

  it("treats the --no-* negation form as changed (Effect CLI boolean negation)", () => {
    expect(legacySeedChangedTargetFlags(["seed", "buckets", "--no-linked"])).toEqual(["linked"]);
    expect(legacySeedChangedTargetFlags(["seed", "buckets", "--no-local"])).toEqual(["local"]);
    expect(legacySeedChangedTargetFlags(["seed", "buckets", "--no-local", "--linked"])).toEqual([
      "linked",
      "local",
    ]);
  });
});

describe("legacyAssertSeedTargetsExclusive", () => {
  it("fails when both --local and --linked are set (cobra mutual exclusivity)", () => {
    const exit = Effect.runSyncExit(
      legacyAssertSeedTargetsExclusive(["seed", "buckets", "--local", "--linked"]),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain(
      "if any flags in the group [linked local] are set none of the others can be; [linked local] were all set",
    );
  });

  it("fails for the --no-local --linked negation combo (both changed)", () => {
    const exit = Effect.runSyncExit(
      legacyAssertSeedTargetsExclusive(["seed", "buckets", "--no-local", "--linked"]),
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
      expect(Exit.isSuccess(Effect.runSyncExit(legacyAssertSeedTargetsExclusive(args)))).toBe(true);
    }
  });
});
