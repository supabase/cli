import { describe, expect, it } from "vitest";
import type { BenchReport, RunSample } from "./bench-report.ts";
import { BENCH_MARKER, parseSummaryArgs, renderSummary, summaryNotice } from "./bench-summary.ts";

const run = (wallMs: number, calls: number, endpoints: Record<string, number>): RunSample => ({
  wallMs,
  exitCode: 0,
  tracedExitCode: 0,
  trace: {
    skippedLines: 0,
    spans: { "cli.run": { totalMs: wallMs / 2, count: 1 } },
    api: { apiCalls: calls, externalCalls: 0, errorStatuses: 0, endpoints, requestLogCount: calls },
  },
});

const runs = (n: number, make: (i: number) => RunSample) =>
  Array.from({ length: n }, (_, i) => make(i));

const report = (workloads: BenchReport["workloads"]): BenchReport => ({
  base: "/base/supabase",
  branch: "/branch/supabase",
  baseSizeBytes: 1000,
  branchSizeBytes: 1500,
  runs: 5,
  warmup: 1,
  trace: true,
  apiUrl: "http://127.0.0.1:1",
  workloads,
});

const steady = (id: string, args: ReadonlyArray<string>) => ({
  id,
  args,
  base: runs(5, (i) => run(30 + i, 0, {})),
  branch: runs(5, (i) => run(30 + i, 0, {})),
});

const migrationNew = {
  id: "migration-new",
  args: ["migration", "new", "bench"],
  base: runs(5, (i) => run(50 + i, 0, {})),
  branch: runs(5, (i) => run(120 + i, 1, { "GET /v1/projects/abc": 1 })),
};

describe("renderSummary", () => {
  it("leads with no changes found and shows commands, not workload ids", () => {
    const sized = {
      ...report([steady("version", ["--version"])]),
      baseSizeBytes: 140269744,
      branchSizeBytes: 140269744,
    };
    const markdown = renderSummary(sized, "unused", {
      target: "summary",
      headSha: "abcdef1234567890",
      baseRef: "develop",
      mergeBase: "1234567890abcdef",
    });

    expect(markdown).toContain("## CLI benchmark: no changes found");
    expect(markdown).toContain(
      "Commit `abcdef1` against `develop` at `1234567` · 5 runs each · report only, never blocks merging",
    );
    expect(markdown).toContain("| `supabase --version` | 32 ms | 32 ms | no real change |");
    expect(markdown).toContain("API calls: unchanged for the command.");
    expect(markdown).toContain("Binary size: 133.8 MB, unchanged.");
    expect(markdown).not.toContain("⚠️");
  });

  it("shows a binary size change in MB, or KB when it is small", () => {
    const grown = {
      ...report([steady("version", ["--version"])]),
      baseSizeBytes: 140269744,
      branchSizeBytes: 140269744 + 3 * 1048576,
    };
    const nudged = { ...grown, branchSizeBytes: 140269744 + 2048 };

    expect(renderSummary(grown, "unused")).toContain(
      "Binary size: 136.8 MB, up 3.0 MB from 133.8 MB.",
    );
    expect(renderSummary(nudged, "unused")).toContain("up 2.0 KB from 133.8 MB");
  });

  it("explains a new API call in plain words and counts each command once", () => {
    const markdown = renderSummary(report([migrationNew]), "unused");

    expect(markdown).toContain("## CLI benchmark: 1 thing to check");
    expect(markdown).toContain(
      "⚠️ `supabase migration new bench` now calls the Management API. It made no calls before and now makes 1 (`GET /v1/projects/abc`).",
    );
    expect(markdown).toContain("slower by 70 ms (+135%)");
  });

  it("keeps command text from the benchmarked build inside code spans", () => {
    const markdown = renderSummary(report([steady("x", ["a`@someone`", "b|c"])]), "unused");

    expect(markdown).toContain("`supabase a'@someone' b\\|c`");
  });

  it("says nothing was benchmarked instead of a clean pass when there are no commands", () => {
    const markdown = renderSummary(report([]), "unused");

    expect(markdown).toContain("## CLI benchmark: no commands were benchmarked");
    expect(markdown).not.toContain("no changes found");
  });

  it("describes a dropped API call with a singular count", () => {
    const dropped = {
      id: "list",
      args: ["projects", "list"],
      base: runs(5, (i) => run(30 + i, 1, { "GET /v1/projects": 1 })),
      branch: runs(5, (i) => run(30 + i, 0, {})),
    };

    const markdown = renderSummary(report([dropped]), "unused");

    expect(markdown).toContain(
      "⚠️ `supabase projects list` no longer calls the Management API. It made 1 call before and now makes none.",
    );
  });

  it("names the failed step and stays a notice when there is no report", () => {
    const markdown = renderSummary(undefined, "The build of this commit failed.", {
      target: "summary",
    });

    expect(markdown).toContain("## CLI benchmark: could not run");
    expect(markdown).toContain("The build of this commit failed.");
    expect(markdown).not.toContain("/bench");
  });

  it("adds the marker, re-run hint only to the comment", () => {
    const input = report([steady("version", ["--version"])]);
    const context = { headSha: "abcdef1234" } as const;

    const comment = renderSummary(input, "unused", { target: "comment", ...context });
    const summary = renderSummary(input, "unused", { target: "summary", ...context });

    expect(BENCH_MARKER).toBe("<!-- cli-bench:pr -->");
    expect(comment.startsWith(`${BENCH_MARKER}\n`)).toBe(true);
    expect(comment).toContain("Comment `/bench` to run it again on the latest commit.");
    expect(summary).not.toContain(BENCH_MARKER);
    expect(summary).not.toContain("/bench");
  });

  it("does not claim a missing timing verdict when commands were not comparable", () => {
    const failing = (wallMs: number): RunSample => ({ ...run(wallMs, 0, {}), exitCode: 1 });

    const markdown = renderSummary(
      report([
        {
          id: "broken",
          args: ["x"],
          base: runs(5, (i) => run(30 + i, 0, {})),
          branch: runs(5, (i) => failing(30 + i)),
        },
      ]),
      "unused",
    );

    expect(markdown).toContain("No phase deltas are available; some commands were not comparable.");
    expect(markdown).toContain("not compared");
  });

  it("says API calls were not counted when no call data exists", () => {
    const noTrace = (wallMs: number): RunSample => ({ wallMs, exitCode: 0 });
    const markdown = renderSummary(
      {
        ...report([
          {
            id: "a",
            args: ["x"],
            base: runs(5, (i) => noTrace(30 + i)),
            branch: runs(5, (i) => noTrace(30 + i)),
          },
        ]),
        trace: false,
      },
      "unused",
    );

    expect(markdown).toContain("API calls were not counted.");
  });
});

describe("summaryNotice", () => {
  const ok = { branchBuild: "ok", baseBuild: "ok", replay: "ok" } as const;

  it("is undefined when every step succeeded", () => {
    expect(summaryNotice(ok)).toBeUndefined();
  });

  it.each([
    { failed: { branchBuild: "failed" }, expected: "build of this commit failed" },
    { failed: { baseBuild: "failed" }, expected: "build of the base branch failed" },
    { failed: { replay: "failed" }, expected: "test server failed to start" },
  ] as const)("names the failed step: $expected", ({ failed, expected }) => {
    expect(summaryNotice({ ...ok, ...failed })).toContain(expected);
  });

  it("reports the earliest failed step when later ones were skipped", () => {
    expect(
      summaryNotice({ branchBuild: "failed", baseBuild: "failed", replay: "failed" }),
    ).toContain("build of this commit failed");
  });
});

describe("parseSummaryArgs", () => {
  it("rejects an unknown step outcome", () => {
    expect(() => parseSummaryArgs(["--report", "r.json", "--replay", "maybe"])).toThrow("--replay");
  });

  it("needs a report unless a step failed", () => {
    expect(() => parseSummaryArgs([])).toThrow();
    expect(parseSummaryArgs(["--replay", "failed"])).toMatchObject({
      report: undefined,
      branchBuild: "ok",
      baseBuild: "ok",
      replay: "failed",
    });
    expect(
      parseSummaryArgs(["--report", "r.json", "--head-sha", "abc", "--comment-out", "c.md"]),
    ).toMatchObject({ report: "r.json", replay: "ok", headSha: "abc", commentOut: "c.md" });
  });
});
