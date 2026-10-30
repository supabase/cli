import { describe, expect, test } from "bun:test";
import { composeBody, failureMarkdown } from "./post-comment.ts";
import { resolveBench, SKIP_REASON } from "./resolve.ts";

const BOT = "github-actions[bot]";
const lightweight = (content: string) => ({
  id: 5,
  body: composeBody({ lightweight: { sha: "abc1234", content } }),
  authorLogin: BOT,
});
const reported = lightweight("### Lightweight Commands: no changes found");

describe("resolveBench", () => {
  test("benchmarks the first push of a pull request that has no comment yet", () => {
    expect(resolveBench({ runAttempt: 1, isFork: false, comments: [] }).shouldRun).toBe(true);
  });

  test("skips a later push while the comment reports a result, and says how to refresh it", () => {
    const result = resolveBench({ runAttempt: 1, isFork: false, comments: [reported] });

    expect(result).toEqual({ shouldRun: false, skipReason: SKIP_REASON });
    expect(SKIP_REASON).toContain("`/bench`");
  });

  test("benchmarks again when the comment reports a failed run", () => {
    const failed = lightweight(failureMarkdown("lightweight"));

    expect(resolveBench({ runAttempt: 1, isFork: false, comments: [failed] }).shouldRun).toBe(true);
  });

  test("benchmarks when the comment holds only an integration-heavy result", () => {
    const stackOnly = {
      id: 5,
      body: composeBody({
        "integration-heavy": {
          sha: "abc1234",
          content: "### Integration Heavy Commands: no changes found",
        },
      }),
      authorLogin: BOT,
    };

    expect(resolveBench({ runAttempt: 1, isFork: false, comments: [stackOnly] }).shouldRun).toBe(
      true,
    );
  });

  test("benchmarks every re-run even when the comment reports a result", () => {
    expect(resolveBench({ runAttempt: 2, isFork: false, comments: [reported] }).shouldRun).toBe(
      true,
    );
  });

  test("ignores a marker pasted by someone else", () => {
    const forged = { ...reported, authorLogin: "mallory" };

    expect(resolveBench({ runAttempt: 1, isFork: false, comments: [forged] }).shouldRun).toBe(true);
  });

  test("benchmarks every push of a fork pull request, which never has a comment", () => {
    expect(resolveBench({ runAttempt: 1, isFork: true, comments: [reported] }).shouldRun).toBe(
      true,
    );
  });
});
