import { describe, expect, it } from "vitest";

import { legacySeedChangedTargetFlags } from "./buckets.flags.ts";

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
});
