import { describe, expect, it } from "vitest";

import { closestByName } from "./closest-branch.ts";

const branches = ["feature-x", "staging", "Main", "add_profiles", "db"].map((name) => ({ name }));

describe("closestByName", () => {
  it.each([
    { word: "feature-y", expected: "feature-x" },
    { word: "Feature-X", expected: "feature-x" },
    { word: "stagin", expected: "staging" },
    { word: "staging2", expected: "staging" },
    { word: "main", expected: "Main" },
    { word: "add_profile", expected: "add_profiles" },
    { word: "  staging  ", expected: "staging" },
  ])("finds $expected for $word", ({ word, expected }) => {
    expect(closestByName(branches, word)?.name).toBe(expected);
  });

  it.each(["production", "feature-xyz-long", "x", "dx", "fi"])(
    "finds nothing for %s, which is more than two edits from every name",
    (word) => {
      expect(closestByName(branches, word)).toBeUndefined();
    },
  );

  it("lets a short word match only by case", () => {
    expect(closestByName(branches, "DB")?.name).toBe("db");
    expect(closestByName(branches, "dc")).toBeUndefined();
  });

  it("prefers the fewest edits, then the first name alphabetically", () => {
    const names = [{ name: "release-b" }, { name: "release-a" }, { name: "release-ab" }];
    expect(closestByName(names, "release-c")?.name).toBe("release-a");
    expect(closestByName(names, "release-a")?.name).toBe("release-a");
  });

  it("finds nothing among no branches", () => {
    expect(closestByName([], "staging")).toBeUndefined();
  });
});
