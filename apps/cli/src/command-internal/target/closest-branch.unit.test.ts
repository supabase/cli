import { describe, expect, it } from "vitest";

import { closestByName, closestWord, nearMissByName } from "./closest-branch.ts";

const branches = ["feature-x", "staging", "Main", "add_profiles", "db"].map((name) => ({ name }));

describe("closestByName", () => {
  it.each([
    { word: "feature-y", expected: "feature-x" },
    { word: "Feature-X", expected: "feature-x" },
    { word: "stagin", expected: "staging" },
    { word: "stagign", expected: "staging" },
    { word: "mian", expected: "Main" },
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

describe("nearMissByName", () => {
  const projectBranches = [
    { name: "main", isDefault: true },
    ...["develop", "staging", "app", "dev", "prod"].map((name) => ({ name, isDefault: false })),
  ];
  const nearMiss = (word: string) =>
    nearMissByName(projectBranches, word, (branch) => branch.isDefault)?.name;

  it.each(["mail", "man", "rain", "api", "pro", "devel"])(
    "leaves %s an ordinary word, being close only to short names, the default branch or neither",
    (word) => {
      expect(nearMiss(word)).toBeUndefined();
    },
  );

  it.each([
    { word: "stagin", expected: "staging" },
    { word: "stagign", expected: "staging" },
    { word: "Dev", expected: "dev" },
    { word: "dev", expected: "dev" },
    { word: "MAIN", expected: "main" },
  ])("takes $word for $expected", ({ word, expected }) => {
    expect(nearMiss(word)).toBe(expected);
  });

  it("takes the first name alphabetically when several match ignoring case", () => {
    const names = [{ name: "release-b" }, { name: "Release-A" }, { name: "release-a" }];
    expect(nearMissByName(names, "RELEASE-A", () => false)?.name).toBe("Release-A");
  });

  it("finds nothing among no branches", () => {
    expect(nearMissByName([], "staging", () => false)).toBeUndefined();
  });
});

describe("closestWord", () => {
  const words = ["local", "migrations", "remote"];

  it.each([
    { word: "lcoal", expected: "local" },
    { word: "LOCAL", expected: "local" },
    { word: "loc", expected: "local" },
    { word: "locall", expected: "local" },
    { word: "remove", expected: "remote" },
    { word: "migraitons", expected: "migrations" },
    { word: "  remtoe ", expected: "remote" },
  ])("finds $expected for $word within two edits", ({ word, expected }) => {
    expect(closestWord(words, word, 2)).toBe(expected);
  });

  it.each(["lo", "main", "feature-x", "migrate", ""])(
    "finds nothing for %s, which is more than two edits from every word",
    (word) => {
      expect(closestWord(words, word, 2)).toBeUndefined();
    },
  );

  it("takes the nearest word, then the earlier one", () => {
    expect(closestWord(["abcd", "abce"], "abcf", 2)).toBe("abcd");
    expect(closestWord(["abxx", "abcx"], "abcd", 2)).toBe("abcx");
  });
});
