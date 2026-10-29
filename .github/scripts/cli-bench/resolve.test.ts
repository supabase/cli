import { describe, expect, test } from "bun:test";
import { BENCH_MARKER, FAILURE_TITLE } from "./post-comment.ts";
import { resolveBench, SKIP_REASON } from "./resolve.ts";

const BOT = "github-actions[bot]";
const reported = {
  id: 5,
  body: `${BENCH_MARKER}\n## CLI benchmark: no changes found`,
  authorLogin: BOT,
};

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
    const failed = { ...reported, body: `${BENCH_MARKER}\n${FAILURE_TITLE}` };

    expect(resolveBench({ runAttempt: 1, isFork: false, comments: [failed] }).shouldRun).toBe(true);
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
