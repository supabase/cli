/**
 * Pure pieces of the weekly test-suite health report (CLI-2541): test-file tier
 * classification, LOC aggregation and week-over-week diffing, growth/duration ranking, and
 * flaky-test detection. The impure half — git history, `gh` API calls, and artifact downloads —
 * lives in `tools/test-health-report.ts`.
 */

export type TestTier = "unit" | "integration" | "e2e" | "live" | "other";

const TIER_SUFFIXES: ReadonlyArray<readonly [string, TestTier]> = [
  [".unit.test.ts", "unit"],
  [".integration.test.ts", "integration"],
  [".e2e.test.ts", "e2e"],
  [".live.test.ts", "live"],
];

/** Tiers follow the `*.unit.test.ts` / `*.integration.test.ts` / `*.e2e.test.ts` / `*.live.test.ts`
 * naming convention; a bare `*.test.ts` file (e.g. under `.github/scripts`) is `"other"`. */
export function classifyTestTier(path: string): TestTier {
  for (const [suffix, tier] of TIER_SUFFIXES) {
    if (path.endsWith(suffix)) {
      return tier;
    }
  }
  return "other";
}

/** The owning workspace for a repo-relative path, e.g. `apps/cli` or `packages/api`; anything
 * outside `apps/*` or `packages/*` (root scripts, `.github/scripts`, `tools/`) is `"root"`. */
export function workspaceForPath(path: string): string {
  const match = /^(apps|packages)\/([^/]+)\//.exec(path);
  return match ? `${match[1]}/${match[2]}` : "root";
}

export interface TestFileLoc {
  readonly path: string;
  readonly loc: number;
}

export interface WorkspaceTierLoc {
  readonly workspace: string;
  readonly tier: TestTier;
  readonly loc: number;
  readonly fileCount: number;
}

function groupKey(workspace: string, tier: string): string {
  return `${workspace}\u0000${tier}`;
}

/** Sums LOC per workspace/tier pair, sorted by workspace then tier for stable rendering. */
export function aggregateLocByWorkspaceTier(files: readonly TestFileLoc[]): WorkspaceTierLoc[] {
  const totals = new Map<string, { loc: number; fileCount: number }>();
  for (const file of files) {
    const key = groupKey(workspaceForPath(file.path), classifyTestTier(file.path));
    const existing = totals.get(key) ?? { loc: 0, fileCount: 0 };
    totals.set(key, { loc: existing.loc + file.loc, fileCount: existing.fileCount + 1 });
  }
  return [...totals.entries()]
    .map(([key, value]) => {
      const [workspace = "root", tier = "other"] = key.split("\u0000");
      return { workspace, tier: tier as TestTier, ...value };
    })
    .sort((a, b) => a.workspace.localeCompare(b.workspace) || a.tier.localeCompare(b.tier));
}

export interface WorkspaceTierChange extends WorkspaceTierLoc {
  readonly previousLoc: number;
  readonly change: number;
}

/** Joins this week's per-workspace/tier LOC against last week's, keeping every group that had
 * LOC in either snapshot (a tier that emptied out this week still shows its drop to zero). */
export function diffLocByWorkspaceTier(
  current: readonly WorkspaceTierLoc[],
  previous: readonly WorkspaceTierLoc[],
): WorkspaceTierChange[] {
  const previousByKey = new Map(
    previous.map((entry) => [groupKey(entry.workspace, entry.tier), entry.loc]),
  );
  const currentByKey = new Map(
    current.map((entry) => [groupKey(entry.workspace, entry.tier), entry]),
  );
  const keys = new Set([...currentByKey.keys(), ...previousByKey.keys()]);

  const changes: WorkspaceTierChange[] = [];
  for (const key of keys) {
    const [workspace = "root", tier = "other"] = key.split("\u0000");
    const entry = currentByKey.get(key);
    const previousLoc = previousByKey.get(key) ?? 0;
    const loc = entry?.loc ?? 0;
    changes.push({
      workspace,
      tier: tier as TestTier,
      loc,
      fileCount: entry?.fileCount ?? 0,
      previousLoc,
      change: loc - previousLoc,
    });
  }
  return changes.sort(
    (a, b) => a.workspace.localeCompare(b.workspace) || a.tier.localeCompare(b.tier),
  );
}

export interface FileGrowth {
  readonly path: string;
  readonly loc: number;
  readonly previousLoc: number;
  readonly growth: number;
}

/** The files whose LOC grew the most over the week, largest growth first; ties broken by path.
 * A file absent from `previous` counts as growth from zero. Files that shrank or disappeared are
 * excluded — this ranks growth, not overall churn. */
export function fastestGrowingFiles(
  current: readonly TestFileLoc[],
  previous: readonly TestFileLoc[],
  limit = 10,
): FileGrowth[] {
  const previousByPath = new Map(previous.map((entry) => [entry.path, entry.loc]));
  return current
    .map((file) => {
      const previousLoc = previousByPath.get(file.path) ?? 0;
      return { path: file.path, loc: file.loc, previousLoc, growth: file.loc - previousLoc };
    })
    .filter((entry) => entry.growth > 0)
    .sort((a, b) => b.growth - a.growth || a.path.localeCompare(b.path))
    .slice(0, limit);
}

export interface TimingEntry {
  readonly workspace: string;
  readonly path: string;
  readonly duration: number;
  readonly failed: boolean;
}

export interface FileDuration {
  readonly workspace: string;
  readonly path: string;
  readonly durationMs: number;
}

/** The slowest test files over the week, by the longest duration recorded for each file across
 * every run's results cache (a file's duration only reflects its own run, so the max is the best
 * single estimate of how slow it can be). */
export function slowestFiles(entries: readonly TimingEntry[], limit = 10): FileDuration[] {
  const slowestByKey = new Map<string, FileDuration>();
  for (const entry of entries) {
    const key = groupKey(entry.workspace, entry.path);
    const existing = slowestByKey.get(key);
    const durationMs = Math.round(entry.duration);
    if (!existing || durationMs > existing.durationMs) {
      slowestByKey.set(key, { workspace: entry.workspace, path: entry.path, durationMs });
    }
  }
  return [...slowestByKey.values()]
    .sort((a, b) => b.durationMs - a.durationMs || a.path.localeCompare(b.path))
    .slice(0, limit);
}

export interface FlakyFile {
  readonly workspace: string;
  readonly path: string;
  readonly failureCount: number;
}

/** Files that failed in at least one of the week's develop/merge-queue runs, most-failed first.
 * Only detects a file failing within a run's own results cache — it can't distinguish "flaky" from
 * "broken and later fixed", since both look identical from a single week of run outcomes. */
export function flakyFiles(entries: readonly TimingEntry[]): FlakyFile[] {
  const failuresByKey = new Map<string, FlakyFile>();
  for (const entry of entries) {
    if (!entry.failed) {
      continue;
    }
    const key = groupKey(entry.workspace, entry.path);
    const existing = failuresByKey.get(key);
    failuresByKey.set(key, {
      workspace: entry.workspace,
      path: entry.path,
      failureCount: (existing?.failureCount ?? 0) + 1,
    });
  }
  return [...failuresByKey.values()].sort(
    (a, b) => b.failureCount - a.failureCount || a.path.localeCompare(b.path),
  );
}

export interface RunAttemptJobs {
  readonly runId: number;
  readonly runUrl: string;
  /** The attempt number of the run's current (latest) state. */
  readonly finalAttempt: number;
  readonly finalConclusion: string | null;
  /** Job name/conclusion pairs from the run's first attempt. */
  readonly attempt1Jobs: ReadonlyArray<{
    readonly name: string;
    readonly conclusion: string | null;
  }>;
}

export interface RetriedJobFailure {
  readonly runId: number;
  readonly runUrl: string;
  readonly finalAttempt: number;
  readonly jobName: string;
}

/**
 * Runs that ultimately succeeded but needed a re-run, with the job(s) that failed on attempt 1.
 * This detects retry-flakiness at job granularity only: the Actions API reports per-job, not
 * per-test-file, outcomes for a past attempt, so a job spanning many test files (e.g. "Run unit
 * tests") can't be narrowed down to the one file that failed without parsing job logs.
 */
export function retriedJobFailures(runs: readonly RunAttemptJobs[]): RetriedJobFailure[] {
  const failures: RetriedJobFailure[] = [];
  for (const run of runs) {
    if (run.finalConclusion !== "success" || run.finalAttempt <= 1) {
      continue;
    }
    for (const job of run.attempt1Jobs) {
      if (job.conclusion === "failure") {
        failures.push({
          runId: run.runId,
          runUrl: run.runUrl,
          finalAttempt: run.finalAttempt,
          jobName: job.name,
        });
      }
    }
  }
  return failures;
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function formatChange(change: number): string {
  if (change === 0) {
    return "0";
  }
  return change > 0 ? `+${change}` : `${change}`;
}

function markdownTable(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  if (rows.length === 0) {
    return "_none_";
  }
  const headerRow = `| ${headers.join(" | ")} |`;
  const separatorRow = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyRows = rows.map((row) => `| ${row.join(" | ")} |`);
  return [headerRow, separatorRow, ...bodyRows].join("\n");
}

interface ReportMetadata {
  readonly headSha: string;
  readonly weekAgoSha: string;
  readonly weekAgoDate: string;
  readonly runsAnalyzed: number;
  /** Caveats surfaced to the reader, e.g. sampling limits or missing artifact kinds. */
  readonly notes: readonly string[];
}

export interface ReportInput {
  readonly metadata: ReportMetadata;
  readonly locChanges: readonly WorkspaceTierChange[];
  readonly fastestGrowing: readonly FileGrowth[];
  readonly slowest: readonly FileDuration[];
  readonly flakyFiles: readonly FlakyFile[];
  readonly retriedJobFailures: readonly RetriedJobFailure[];
}

/** Renders the full report as GitHub-flavored markdown, suitable for `$GITHUB_STEP_SUMMARY`. */
export function renderMarkdownReport(input: ReportInput): string {
  const { metadata } = input;
  const lines: string[] = [
    "# Weekly test-suite health report",
    "",
    `Comparing \`${metadata.headSha.slice(0, 12)}\` against \`${metadata.weekAgoSha.slice(0, 12)}\` (${metadata.weekAgoDate}), across ${metadata.runsAnalyzed} develop/merge-queue Test run(s) from the past week.`,
    "",
  ];

  if (metadata.notes.length > 0) {
    lines.push(...metadata.notes.map((note) => `> ${note}`), "");
  }

  lines.push(
    "## Test LOC by workspace and tier",
    "",
    markdownTable(
      ["Workspace", "Tier", "LOC", "Files", "Δ vs last week"],
      input.locChanges
        .filter((entry) => entry.loc > 0 || entry.previousLoc > 0)
        .map((entry) => [
          entry.workspace,
          entry.tier,
          String(entry.loc),
          String(entry.fileCount),
          formatChange(entry.change),
        ]),
    ),
    "",
    "## Fastest-growing test files (by LOC)",
    "",
    markdownTable(
      ["Path", "LOC", "Δ vs last week"],
      input.fastestGrowing.map((entry) => [
        entry.path,
        String(entry.loc),
        formatChange(entry.growth),
      ]),
    ),
    "",
    "## Slowest test files",
    "",
    markdownTable(
      ["Workspace", "Path", "Duration"],
      input.slowest.map((entry) => [entry.workspace, entry.path, formatDuration(entry.durationMs)]),
    ),
    "",
    "## Flaky tests",
    "",
    "### Files that failed in a develop/merge-queue run",
    "",
    markdownTable(
      ["Workspace", "Path", "Failures"],
      input.flakyFiles.map((entry) => [entry.workspace, entry.path, String(entry.failureCount)]),
    ),
    "",
    "### Runs where attempt 1 failed and a later attempt succeeded",
    "",
    markdownTable(
      ["Run", "Job", "Succeeded on attempt"],
      input.retriedJobFailures.map((entry) => [
        `[${entry.runId}](${entry.runUrl})`,
        entry.jobName,
        String(entry.finalAttempt),
      ]),
    ),
    "",
  );

  return lines.join("\n");
}
