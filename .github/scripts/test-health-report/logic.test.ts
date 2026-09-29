import { describe, expect, test } from "bun:test";
import {
  aggregateLocByWorkspaceTier,
  classifyTestTier,
  diffLocByWorkspaceTier,
  fastestGrowingFiles,
  flakyFiles,
  renderMarkdownReport,
  retriedJobFailures,
  slowestFiles,
  workspaceForPath,
} from "./logic.ts";

describe("classifyTestTier", () => {
  test.each([
    ["src/foo.unit.test.ts", "unit"],
    ["src/foo.integration.test.ts", "integration"],
    ["src/foo.e2e.test.ts", "e2e"],
    ["src/foo.live.test.ts", "live"],
    [".github/scripts/contribution-gate.test.ts", "other"],
  ] as const)("classifies %s as %s", (path, tier) => {
    expect(classifyTestTier(path)).toBe(tier);
  });
});

describe("workspaceForPath", () => {
  test.each([
    ["apps/cli/src/foo.unit.test.ts", "apps/cli"],
    ["packages/api/src/foo.integration.test.ts", "packages/api"],
    [".github/scripts/contribution-gate.test.ts", "root"],
    ["tools/lib/test-health-report.unit.test.ts", "root"],
  ])("maps %s to workspace %s", (path, workspace) => {
    expect(workspaceForPath(path)).toBe(workspace);
  });
});

describe("aggregateLocByWorkspaceTier", () => {
  test("sums LOC per workspace/tier and counts files", () => {
    const totals = aggregateLocByWorkspaceTier([
      { path: "apps/cli/src/a.unit.test.ts", loc: 10 },
      { path: "apps/cli/src/b.unit.test.ts", loc: 20 },
      { path: "apps/cli/src/c.integration.test.ts", loc: 5 },
      { path: "packages/api/src/a.unit.test.ts", loc: 7 },
    ]);

    expect(totals).toEqual([
      { workspace: "apps/cli", tier: "integration", loc: 5, fileCount: 1 },
      { workspace: "apps/cli", tier: "unit", loc: 30, fileCount: 2 },
      { workspace: "packages/api", tier: "unit", loc: 7, fileCount: 1 },
    ]);
  });
});

describe("diffLocByWorkspaceTier", () => {
  test("computes week-over-week change and keeps groups that emptied out", () => {
    const current = [{ workspace: "apps/cli", tier: "unit" as const, loc: 30, fileCount: 2 }];
    const previous = [
      { workspace: "apps/cli", tier: "unit" as const, loc: 10, fileCount: 1 },
      { workspace: "apps/cli", tier: "integration" as const, loc: 40, fileCount: 3 },
    ];

    expect(diffLocByWorkspaceTier(current, previous)).toEqual([
      {
        workspace: "apps/cli",
        tier: "integration",
        loc: 0,
        fileCount: 0,
        previousLoc: 40,
        change: -40,
      },
      { workspace: "apps/cli", tier: "unit", loc: 30, fileCount: 2, previousLoc: 10, change: 20 },
    ]);
  });
});

describe("fastestGrowingFiles", () => {
  test("ranks growth descending and treats a new file as growth from zero", () => {
    const current = [
      { path: "src/a.unit.test.ts", loc: 100 },
      { path: "src/b.unit.test.ts", loc: 50 },
      { path: "src/new.unit.test.ts", loc: 30 },
      { path: "src/shrunk.unit.test.ts", loc: 5 },
    ];
    const previous = [
      { path: "src/a.unit.test.ts", loc: 40 },
      { path: "src/b.unit.test.ts", loc: 45 },
      { path: "src/shrunk.unit.test.ts", loc: 50 },
    ];

    expect(fastestGrowingFiles(current, previous, 2)).toEqual([
      { path: "src/a.unit.test.ts", loc: 100, previousLoc: 40, growth: 60 },
      { path: "src/new.unit.test.ts", loc: 30, previousLoc: 0, growth: 30 },
    ]);
  });

  test("excludes files that shrank or stayed the same", () => {
    const current = [{ path: "src/a.unit.test.ts", loc: 10 }];
    const previous = [{ path: "src/a.unit.test.ts", loc: 10 }];

    expect(fastestGrowingFiles(current, previous)).toEqual([]);
  });
});

describe("slowestFiles", () => {
  test("keeps the max duration per file across runs and ranks descending", () => {
    const entries = [
      { workspace: "apps/cli", path: "src/a.e2e.test.ts", duration: 1200.4, failed: false },
      { workspace: "apps/cli", path: "src/a.e2e.test.ts", duration: 900, failed: false },
      { workspace: "apps/cli", path: "src/b.e2e.test.ts", duration: 5000, failed: false },
    ];

    expect(slowestFiles(entries, 10)).toEqual([
      { workspace: "apps/cli", path: "src/b.e2e.test.ts", durationMs: 5000 },
      { workspace: "apps/cli", path: "src/a.e2e.test.ts", durationMs: 1200 },
    ]);
  });

  test("limits to the requested count", () => {
    const entries = Array.from({ length: 15 }, (_, index) => ({
      workspace: "apps/cli",
      path: `src/f${index}.e2e.test.ts`,
      duration: index,
      failed: false,
    }));

    expect(slowestFiles(entries, 10)).toHaveLength(10);
  });
});

describe("flakyFiles", () => {
  test("counts failures per file and ignores passing entries", () => {
    const entries = [
      { workspace: "apps/cli", path: "src/a.e2e.test.ts", duration: 100, failed: true },
      { workspace: "apps/cli", path: "src/a.e2e.test.ts", duration: 100, failed: true },
      { workspace: "apps/cli", path: "src/b.e2e.test.ts", duration: 100, failed: false },
    ];

    expect(flakyFiles(entries)).toEqual([
      { workspace: "apps/cli", path: "src/a.e2e.test.ts", failureCount: 2 },
    ]);
  });
});

describe("retriedJobFailures", () => {
  test("reports attempt-1 failures only for runs that ultimately succeeded after a retry", () => {
    const runs = [
      {
        runId: 1,
        runUrl: "https://example.com/1",
        finalAttempt: 2,
        finalConclusion: "success",
        attempt1Jobs: [
          { name: "Run unit tests", conclusion: "failure" },
          { name: "Run integration tests", conclusion: "success" },
        ],
      },
      {
        // Never retried — attempt 1 is the only (and final) attempt.
        runId: 2,
        runUrl: "https://example.com/2",
        finalAttempt: 1,
        finalConclusion: "success",
        attempt1Jobs: [{ name: "Run unit tests", conclusion: "failure" }],
      },
      {
        // Retried but still failing — not a flaky "later succeeded" case.
        runId: 3,
        runUrl: "https://example.com/3",
        finalAttempt: 2,
        finalConclusion: "failure",
        attempt1Jobs: [{ name: "Run unit tests", conclusion: "failure" }],
      },
    ];

    expect(retriedJobFailures(runs)).toEqual([
      { runId: 1, runUrl: "https://example.com/1", finalAttempt: 2, jobName: "Run unit tests" },
    ]);
  });
});

describe("renderMarkdownReport", () => {
  test("renders every section with an empty-state placeholder when there is no data", () => {
    const markdown = renderMarkdownReport({
      metadata: {
        headSha: "abcdef123456789",
        weekAgoSha: "111111222222333",
        weekAgoDate: "2026-09-22",
        runsAnalyzed: 3,
        notes: ["sampled the last 3 runs for this demo"],
      },
      locChanges: [],
      fastestGrowing: [],
      slowest: [],
      flakyFiles: [],
      retriedJobFailures: [],
    });

    expect(markdown).toContain("# Weekly test-suite health report");
    expect(markdown).toContain("abcdef123456");
    expect(markdown).toContain("> sampled the last 3 runs for this demo");
    expect(markdown).toContain("## Test LOC by workspace and tier");
    expect(markdown).toContain("_none_");
  });

  test("renders populated tables with formatted durations and changes", () => {
    const markdown = renderMarkdownReport({
      metadata: {
        headSha: "abcdef123456789",
        weekAgoSha: "111111222222333",
        weekAgoDate: "2026-09-22",
        runsAnalyzed: 12,
        notes: [],
      },
      locChanges: [
        {
          workspace: "apps/cli",
          tier: "unit",
          loc: 120,
          fileCount: 4,
          previousLoc: 100,
          change: 20,
        },
      ],
      fastestGrowing: [{ path: "src/a.unit.test.ts", loc: 120, previousLoc: 100, growth: 20 }],
      slowest: [{ workspace: "apps/cli", path: "src/a.e2e.test.ts", durationMs: 12345 }],
      flakyFiles: [{ workspace: "apps/cli", path: "src/a.e2e.test.ts", failureCount: 3 }],
      retriedJobFailures: [
        { runId: 42, runUrl: "https://example.com/42", finalAttempt: 2, jobName: "Run unit tests" },
      ],
    });

    expect(markdown).toContain("| apps/cli | unit | 120 | 4 | +20 |");
    expect(markdown).toContain("12.3s");
    expect(markdown).toContain("| apps/cli | src/a.e2e.test.ts | 3 |");
    expect(markdown).toContain("[42](https://example.com/42)");
  });
});
