import { describe, expect, test } from "vitest";
import { analyzeCommits } from "./analyze-commits-title.js";

type ReleaseType = "major" | "minor" | "patch" | null;

const logger = { log: () => {} };

function analyze(messages: readonly unknown[]): ReleaseType {
  return analyzeCommits(
    {},
    {
      commits: messages.map((message, index) => ({ hash: `commit-${index}`, message })),
      logger,
    },
  );
}

describe("analyzeCommits title-only release policy", () => {
  test.each([
    ["feat: add capability", "minor"],
    ["FEAT: add capability", "minor"],
    ["fix: correct behavior", "patch"],
    ["FIX: correct behavior", "patch"],
    ["perf: improve startup", "patch"],
    ["revert: restore behavior", "patch"],
    ["PERF: improve startup", null],
    ["REVERT: restore behavior", null],
    ["Feat: add capability", null],
    ["Fix: correct behavior", null],
    ["ci!: change the release contract", "major"],
    ["chore(scope)!: change the release contract", "major"],
    ["feat(api/v2)!: replace an endpoint", "major"],
    ["fix(scope.with:punctuation): correct behavior", "patch"],
    ["docs: explain behavior\n\nBREAKING CHANGE: words in the body are ignored", null],
    ["fix: first line wins\r\n\r\nfeat!: body lines are ignored", "patch"],
    ["", null],
    ["   ", null],
    [undefined, null],
    [null, null],
    [42, null],
    ["feat:add capability", null],
    ["feat(scope) add capability", null],
    ["prefix feat: add capability", null],
  ] satisfies ReadonlyArray<readonly [unknown, ReleaseType]>)(
    "classifies %j as %s",
    (message, expected) => {
      expect(analyze([message])).toBe(expected);
    },
  );

  test.each([
    [["docs: no release", "fix: patch", "feat: minor"], "minor"],
    [["feat: minor", "ci!: major", "fix: patch"], "major"],
    [["docs: no release", "chore: still no release"], null],
  ] satisfies ReadonlyArray<readonly [readonly string[], ReleaseType]>)(
    "selects the highest bump from %j",
    (messages, expected) => {
      expect(analyze(messages)).toBe(expected);
    },
  );
});
