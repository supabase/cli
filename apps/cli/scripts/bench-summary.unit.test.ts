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
    const markdown = renderSummary(undefined, "The build of this commit failed.", {});

    expect(markdown).toContain("## CLI benchmark: could not run");
    expect(markdown).toContain("The build of this commit failed.");
    expect(markdown).not.toContain("/bench");
  });

  it.each([
    { section: "lightweight", heading: "## CLI benchmark: no changes found" },
    {
      section: "integration-heavy",
      heading: "## CLI benchmark (Integration Heavy Commands): no changes found",
    },
  ] as const)(
    "titles a $section report with its name and leaves the markers and re-run note to the poster",
    ({ section, heading }) => {
      const input = report([steady("version", ["--version"])]);

      const comment = renderSummary(input, "unused", { section });

      expect(comment.startsWith(`${heading}\n`)).toBe(true);
      expect(comment).not.toContain("<!--");
      expect(comment).not.toContain("/bench");
    },
  );

  it("shows a note above the results", () => {
    const markdown = renderSummary(report([steady("version", ["--version"])]), "unused", {
      note: "Some shards did not finish.",
    });

    expect(markdown).toContain("⚠️ Some shards did not finish.");
  });

  it("says the range when per-command run counts differ", () => {
    const fewer = { ...steady("x", ["start"]), base: runs(3, (i) => run(30 + i, 0, {})) };

    const markdown = renderSummary(report([steady("version", ["--version"]), fewer]), "unused");

    expect(markdown).toContain("3-5 runs each");
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

describe("renderSummary for integration-heavy commands", () => {
  const withContainers = (counts: Record<string, number>): RunSample => ({
    wallMs: 1000,
    exitCode: 0,
    tracedExitCode: 0,
    trace: {
      skippedLines: 0,
      spans: Object.fromEntries(
        Object.entries(counts).map(([verb, count]) => [
          `ContainerCli.spawn (${verb})`,
          { totalMs: 5 * count, count },
        ]),
      ),
    },
  });
  const heavy = (
    id: string,
    base: Record<string, number>,
    branch: Record<string, number>,
    extra: Partial<BenchReport["workloads"][number]> = {},
  ) => ({
    id,
    args: ["status"],
    runtime: "docker" as const,
    base: runs(5, () => withContainers(base)),
    branch: runs(5, () => withContainers(branch)),
    ...extra,
  });
  const render = (workloads: BenchReport["workloads"]) =>
    renderSummary(report(workloads), "unused", { section: "integration-heavy" });

  it("shows unchanged container operations with the runtime column", () => {
    const markdown = render([
      heavy("status", { "container inspect": 3 }, { "container inspect": 3 }),
    ]);

    expect(markdown).toContain("## CLI benchmark (Integration Heavy Commands): no changes found");
    expect(markdown).toContain("| Command | Runtime | Before | After | Change |");
    expect(markdown).toContain("| `supabase status` | docker |");
    expect(markdown).toContain("Container operations: unchanged for the command.");
  });

  it("flags an extra container call per verb and counts the command once", () => {
    const markdown = render([
      heavy("status", { "container inspect": 3 }, { "container inspect": 4 }),
    ]);

    expect(markdown).toContain("## CLI benchmark (Integration Heavy Commands): 1 thing to check");
    expect(markdown).toContain(
      "⚠️ `supabase status` runs a different number of container commands: 3 before, 4 now.",
    );
    expect(markdown).toContain("Container operations changed for 1 command:");
    expect(markdown).toContain("`container inspect` 3 -> 4");
    expect(markdown).toContain("| `supabase status` | docker | `container inspect` | 3 | 4 |");
  });

  it("flags container commands that appear where there were none", () => {
    const markdown = render([heavy("status", {}, { ps: 2 })]);

    expect(markdown).toContain(
      "⚠️ `supabase status` now runs container commands. It ran none before and now runs 2.",
    );
  });

  it("does not count container operations for stack workloads, whose container work runs outside the trace", () => {
    const markdown = render([
      heavy("stack-status", { ps: 1 }, { ps: 2 }, { stack: true, runtime: "native" }),
    ]);

    expect(markdown).toContain("Container operations were not counted.");
    expect(markdown).toContain("| `supabase status` | stack, native |");
    expect(markdown).not.toContain("container commands");
  });

  it("leaves container operations out of the lightweight section", () => {
    const markdown = renderSummary(report([heavy("status", { ps: 1 }, { ps: 1 })]), "unused", {});

    expect(markdown).not.toContain("Container operations");
  });
});
