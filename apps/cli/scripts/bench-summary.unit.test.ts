import { describe, expect, it } from "vitest";
import type { BenchReport, RunSample } from "./bench-report.ts";
import { parseSummaryArgs, renderSummary, summaryNotice } from "./bench-summary.ts";

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

describe("renderSummary", () => {
  it("lists a flagged workload first and shows the endpoint that appeared", () => {
    const markdown = renderSummary(
      report([
        {
          id: "migration-new",
          args: ["migration", "new", "bench"],
          base: runs(5, (i) => run(50 + i, 0, {})),
          branch: runs(5, (i) => run(120 + i, 1, { "GET /v1/projects/abc": 1 })),
        },
      ]),
      "unused",
    );

    expect(markdown).toContain("report only");
    expect(markdown).toMatch(/\*\*migration-new\*\* \(new-api-calls\)/u);
    expect(markdown).not.toContain("No flags.");
    expect(markdown).toContain("`GET /v1/projects/abc` 0 -> 1");
    expect(markdown).toContain("slower");
    expect(markdown).toContain("+500 bytes");
  });

  it("says there are no flags and no phase deltas when nothing moved", () => {
    const markdown = renderSummary(
      report([
        {
          id: "version",
          args: ["--version"],
          base: runs(5, (i) => run(30 + i, 0, {})),
          branch: runs(5, (i) => run(30 + i, 0, {})),
        },
      ]),
      "unused",
    );

    expect(markdown).toContain("No flags.");
    expect(markdown).toContain("within noise");
    expect(markdown).toContain("no phase deltas");
  });

  it("reports a missing report with the notice it is given", () => {
    expect(renderSummary(undefined, "no report here")).toContain("no report here");
  });

  it("does not claim a missing timing verdict when workloads were not comparable", () => {
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

    expect(markdown).toContain(
      "No phase deltas are available; some workloads were not comparable.",
    );
  });
});

describe("summaryNotice", () => {
  const ok = { branchBuild: "ok", baseBuild: "ok", replay: "ok" } as const;

  it("is undefined when every step succeeded", () => {
    expect(summaryNotice(ok)).toBeUndefined();
  });

  it.each([
    { failed: { branchBuild: "failed" }, expected: "branch build failed" },
    { failed: { baseBuild: "failed" }, expected: "base build failed" },
    { failed: { replay: "failed" }, expected: "replay server failed to start" },
  ] as const)("names the failed step: $expected", ({ failed, expected }) => {
    expect(summaryNotice({ ...ok, ...failed })).toContain(expected);
  });

  it("reports the earliest failed step when later ones were skipped", () => {
    expect(
      summaryNotice({ branchBuild: "failed", baseBuild: "failed", replay: "failed" }),
    ).toContain("branch build failed");
  });
});

describe("renderSummary without API counts", () => {
  it("says API calls were not counted and keeps table cells intact when an id contains a pipe", () => {
    const noTrace = (wallMs: number): RunSample => ({ wallMs, exitCode: 0 });
    const markdown = renderSummary(
      {
        ...report([
          {
            id: "a|b",
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
    expect(markdown).toContain("a\\|b");
  });
});

describe("parseSummaryArgs", () => {
  it("rejects an unknown step outcome", () => {
    expect(() => parseSummaryArgs(["--report", "r.json", "--replay", "maybe"])).toThrow("--replay");
  });

  it("needs a report unless a step failed", () => {
    expect(() => parseSummaryArgs([])).toThrow();
    expect(parseSummaryArgs(["--replay", "failed"])).toEqual({
      report: undefined,
      branchBuild: "ok",
      baseBuild: "ok",
      replay: "failed",
    });
    expect(parseSummaryArgs(["--report", "r.json"])).toEqual({
      report: "r.json",
      branchBuild: "ok",
      baseBuild: "ok",
      replay: "ok",
    });
  });
});
