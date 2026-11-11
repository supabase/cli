import { describe, expect, it } from "vitest";
import { cliBuildChannel, parseSemver } from "./version.ts";

describe("parseSemver", () => {
  it.each([
    ["3.0.0", { nums: ["3", "0", "0"], prerelease: "" }],
    ["3.0.0-beta.12", { nums: ["3", "0", "0"], prerelease: "beta.12" }],
    ["0.0.0-pr.1234", { nums: ["0", "0", "0"], prerelease: "pr.1234" }],
    ["2.114", { nums: ["2", "114", "0"], prerelease: "" }],
    ["2.114.0+build.7", { nums: ["2", "114", "0"], prerelease: "" }],
  ])("parses %j", (version, expected) => {
    expect(parseSemver(version)).toEqual(expected);
  });

  it.each([
    ["v3.0.0", "a leading v"],
    ["", "an empty string"],
    ["not-a-version", "non-numeric parts"],
    ["02.1.0", "a leading zero in the major"],
    ["2.1.0-01", "a leading zero in a numeric prerelease id"],
    ["2.1.0-alpha..1", "an empty prerelease id"],
  ])("rejects %j (%s)", (version) => {
    expect(parseSemver(version)).toBeUndefined();
  });
});

describe("cliBuildChannel", () => {
  it.each([
    ["3.0.0", "stable"],
    ["3.0.0-beta.12", "beta"],
    ["3.0.0-next.4", "next"],
    ["0.0.0-pr.1234", "preview"],
    ["0.0.0-dev", "development"],
    ["0.0.0-automated", "development"],
    ["3.1.0-alpha.1", "development"],
    ["not-a-version", "development"],
  ])("%j is a %s build", (version, expected) => {
    expect(cliBuildChannel(version)).toBe(expected);
  });
});
