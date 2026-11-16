import { describe, expect, it } from "vitest";
import { analyzeCommits, releaseTypeForTitle } from "./analyze-commits-title.js";

describe("releaseTypeForTitle", () => {
  it.each([
    ["feat(cli): add thing", "minor"],
    ["FEAT: add thing", "minor"],
    ["fix(cli): repair thing", "patch"],
    ["FIX: repair thing", "patch"],
    ["perf(cli): speed up", "patch"],
    ["revert: undo thing", "patch"],
    ["feat(cli)!: drop thing", "major"],
    ["chore!: drop thing", "major"],
    ["fix!: drop thing", "major"],
    ["chore(deps): bump", null],
    ["docs: update", null],
    ["Update README", null],
    ["feat add thing", null],
    ["", null],
  ])("classifies %j as %s", (title, expected) => {
    expect(releaseTypeForTitle(title)).toBe(expected);
  });

  it("only reads the first line", () => {
    expect(releaseTypeForTitle("fix: a\n\nfeat!: b")).toBe("patch");
    expect(releaseTypeForTitle("chore: a\nfeat: b")).toBeNull();
  });
});

describe("analyzeCommits", () => {
  const logger = { log: () => {} };
  const run = (messages: unknown[]) =>
    analyzeCommits({}, { commits: messages.map((message) => ({ message })), logger });

  it("returns the highest release type", () => {
    expect(run(["fix: a", "feat: b", "chore: c"])).toBe("minor");
    expect(run(["fix: a", "perf: b"])).toBe("patch");
    expect(run(["fix: a", "feat(cli)!: b", "feat: c"])).toBe("major");
  });

  it("returns null when nothing triggers a release", () => {
    expect(run(["chore: a", "docs: b", "not conventional"])).toBeNull();
    expect(run([])).toBeNull();
  });

  it("skips commits without a usable title", () => {
    expect(run(["", "   ", undefined, { not: "a string" }, "fix: a"])).toBe("patch");
  });
});
