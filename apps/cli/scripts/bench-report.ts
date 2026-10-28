/**
 * Report schemas and the pure analysis shared by `bench-cli.ts` (which records raw per-run data)
 * and `bench-summary.ts` (which derives flags and verdicts), so thresholds can change without
 * re-running a benchmark.
 */
import { Effect, Schema } from "effect";
import type { ReportSpan } from "./trace-report.ts";

export type Build = "base" | "branch";

const round = (value: number): number => Math.round(value * 100) / 100;

export function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function percentile(values: ReadonlyArray<number>, p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(Math.max(Math.ceil((p / 100) * sorted.length) - 1, 0), sorted.length - 1);
  return sorted[rank]!;
}

export interface TimingSummary {
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly p90: number;
}

export function summarizeTimings(values: ReadonlyArray<number>): TimingSummary {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: round(median(sorted)),
    min: round(sorted[0] ?? 0),
    max: round(sorted[sorted.length - 1] ?? 0),
    p90: round(percentile(sorted, 90)),
  };
}

export interface Delta {
  readonly ms: number;
  readonly pct: number;
}

/** `branch - base`; `pct` is `0` when `baseMedian` is `0` rather than `Infinity`. */
export function deltaOf(baseMedian: number, branchMedian: number): Delta {
  const ms = branchMedian - baseMedian;
  return { ms: round(ms), pct: baseMedian === 0 ? 0 : round((ms / baseMedian) * 100) };
}

const SpanRunSummary = Schema.Struct({ totalMs: Schema.Finite, count: Schema.Finite });
export type SpanRunSummary = typeof SpanRunSummary.Type;

/**
 * Sums duration and counts occurrences of each span name within one run's decoded spans. HTTP
 * client spans are left out: the API-call section reports them per endpoint.
 */
export function summarizeSpanRun(spans: ReadonlyArray<ReportSpan>): Record<string, SpanRunSummary> {
  const result: Record<string, SpanRunSummary> = {};
  for (const span of spans) {
    if (span.http !== undefined) continue;
    const entry = result[span.name] ?? { totalMs: 0, count: 0 };
    result[span.name] = {
      totalMs: entry.totalMs + (span.endMs - span.startMs),
      count: entry.count + 1,
    };
  }
  return result;
}

export interface SpanAggregate {
  readonly medianMs: number;
  readonly medianCount: number;
}

/** Medians each span name's per-run total duration and count across runs; missing runs count as 0. */
export function aggregateSpanRuns(
  runs: ReadonlyArray<Record<string, SpanRunSummary>>,
): Record<string, SpanAggregate> {
  const names = new Set<string>();
  for (const run of runs) for (const name of Object.keys(run)) names.add(name);
  const result: Record<string, SpanAggregate> = {};
  for (const name of names) {
    result[name] = {
      medianMs: round(median(runs.map((run) => run[name]?.totalMs ?? 0))),
      medianCount: round(median(runs.map((run) => run[name]?.count ?? 0))),
    };
  }
  return result;
}

export interface SpanComparison {
  readonly name: string;
  readonly base: SpanAggregate | undefined;
  readonly branch: SpanAggregate | undefined;
  readonly deltaMs: number | undefined;
  readonly onlyIn: Build | undefined;
}

function spanSortKey(entry: SpanComparison): number {
  return entry.deltaMs !== undefined
    ? Math.abs(entry.deltaMs)
    : (entry.branch?.medianMs ?? entry.base?.medianMs ?? 0);
}

/** Pairs base/branch span aggregates by name, sorted by `|delta|` descending; flags one-sided spans. */
export function compareSpans(
  base: Record<string, SpanAggregate>,
  branch: Record<string, SpanAggregate>,
): ReadonlyArray<SpanComparison> {
  const names = new Set([...Object.keys(base), ...Object.keys(branch)]);
  const comparisons = [...names].map((name): SpanComparison => {
    const baseEntry = base[name];
    const branchEntry = branch[name];
    return {
      name,
      base: baseEntry,
      branch: branchEntry,
      deltaMs:
        baseEntry !== undefined && branchEntry !== undefined
          ? round(branchEntry.medianMs - baseEntry.medianMs)
          : undefined,
      onlyIn: baseEntry === undefined ? "branch" : branchEntry === undefined ? "base" : undefined,
    };
  });
  return comparisons.sort((a, b) => spanSortKey(b) - spanSortKey(a));
}

/** Whether the builds exited differently, which makes their timings measure different work. */
export function exitCodesDiffer(
  base: ReadonlyArray<number>,
  branch: ReadonlyArray<number>,
): boolean {
  const codes = (values: ReadonlyArray<number>) =>
    [...new Set(values)].sort((a, b) => a - b).join(",");
  return codes(base) !== codes(branch);
}

/* Workload manifest */

const Workload = Schema.Struct({
  id: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
  cwdSetup: Schema.Literals(["none", "init"]),
  scenario: Schema.optionalKey(Schema.String),
});
export type Workload = typeof Workload.Type;

const WorkloadManifest = Schema.Struct({ workloads: Schema.NonEmptyArray(Workload) });

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkloadManifest));

/** Rules the schema cannot express; returns one message per violation. */
export function validateWorkloads(
  workloads: ReadonlyArray<Workload>,
  context: { readonly apiUrl: string | undefined },
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const workload of workloads) {
    if (seen.has(workload.id)) problems.push(`duplicate workload id "${workload.id}"`);
    seen.add(workload.id);
    if (workload.scenario !== undefined && context.apiUrl === undefined) {
      problems.push(`workload "${workload.id}" names a scenario and needs --api-url`);
    }
  }
  return problems;
}

/** Decodes the text of a workload manifest file. */
export const parseWorkloadManifest = (text: string) =>
  decodeManifest(text).pipe(Effect.map((manifest) => manifest.workloads));

/* HTTP call classification */

export interface HttpCallSummary {
  readonly apiCalls: number;
  readonly externalCalls: number;
  readonly errorStatuses: number;
  readonly endpoints: Record<string, number>;
}

/**
 * Splits a run's HTTP client spans into calls to `apiUrl` (same hostname and port) and calls to
 * any other host. `errorStatuses` counts API calls that got a 4xx or 5xx response.
 */
export function classifyHttpSpans(
  spans: ReadonlyArray<ReportSpan>,
  apiUrl: string,
): HttpCallSummary {
  const url = new URL(apiUrl);
  const apiHost = url.hostname.replace(/^\[|\]$/gu, "");
  const apiPort = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  let apiCalls = 0;
  let externalCalls = 0;
  let errorStatuses = 0;
  const endpoints: Record<string, number> = {};
  for (const span of spans) {
    const http = span.http;
    if (http === undefined) continue;
    if (http.address !== apiHost || (http.port !== undefined && http.port !== apiPort)) {
      externalCalls += 1;
      continue;
    }
    apiCalls += 1;
    if (http.status !== undefined && http.status >= 400) errorStatuses += 1;
    const endpoint = `${http.method} ${http.path ?? "(unknown path)"}`;
    endpoints[endpoint] = (endpoints[endpoint] ?? 0) + 1;
  }
  return { apiCalls, externalCalls, errorStatuses, endpoints };
}

/* Report (raw, as written by `bench-cli.ts --out`) */

const ApiSample = Schema.Struct({
  apiCalls: Schema.Finite,
  externalCalls: Schema.Finite,
  errorStatuses: Schema.Finite,
  endpoints: Schema.Record(Schema.String, Schema.Finite),
  requestLogCount: Schema.Finite,
});

const TraceSample = Schema.Struct({
  skippedLines: Schema.Finite,
  spans: Schema.Record(Schema.String, SpanRunSummary),
  api: Schema.optionalKey(ApiSample),
});

const RunSample = Schema.Struct({
  wallMs: Schema.Finite,
  exitCode: Schema.Finite,
  /** Exit code of the traced launch, recorded even when no spans could be decoded. */
  tracedExitCode: Schema.optionalKey(Schema.Finite),
  trace: Schema.optionalKey(TraceSample),
});
export type RunSample = typeof RunSample.Type;

const WorkloadReport = Schema.Struct({
  id: Schema.String,
  args: Schema.Array(Schema.String),
  base: Schema.Array(RunSample),
  branch: Schema.Array(RunSample),
});
export type WorkloadReport = typeof WorkloadReport.Type;

export const BenchReport = Schema.Struct({
  base: Schema.String,
  branch: Schema.String,
  baseSizeBytes: Schema.optionalKey(Schema.Finite),
  branchSizeBytes: Schema.optionalKey(Schema.Finite),
  runs: Schema.Finite,
  warmup: Schema.Finite,
  trace: Schema.Boolean,
  apiUrl: Schema.optionalKey(Schema.String),
  workloads: Schema.Array(WorkloadReport),
  cpuProfilePath: Schema.optionalKey(Schema.String),
});
export type BenchReport = typeof BenchReport.Type;

const BenchReportJson = Schema.fromJsonString(BenchReport, { space: 2 });
export const decodeBenchReport = Schema.decodeUnknownEffect(BenchReportJson);
export const encodeBenchReport = Schema.encodeEffect(BenchReportJson);

/* Analysis */

export const VERDICT_MIN_PCT = 5;
export const VERDICT_MIN_MS = 5;
export const VERDICT_MIN_SAMPLES = 5;
export const PHASE_ROWS = 3;

export type TimingVerdict = "slower" | "faster" | "within noise" | "not comparable";

/**
 * "slower" or "faster" only when the branch median is outside the base min-max range and the
 * change is at least {@link VERDICT_MIN_PCT} percent and {@link VERDICT_MIN_MS} ms.
 */
export function timingVerdict(
  base: TimingSummary,
  branch: TimingSummary,
  context: { readonly comparable: boolean; readonly samples: number },
): TimingVerdict {
  if (!context.comparable || context.samples < VERDICT_MIN_SAMPLES) return "not comparable";
  const delta = deltaOf(base.median, branch.median);
  if (Math.abs(delta.pct) < VERDICT_MIN_PCT || Math.abs(delta.ms) < VERDICT_MIN_MS) {
    return "within noise";
  }
  if (branch.median > base.max) return "slower";
  if (branch.median < base.min) return "faster";
  return "within noise";
}

export interface ApiSummary {
  readonly medianCalls: number;
  readonly runCalls: ReadonlyArray<number>;
  readonly nonDeterministic: boolean;
  /** Median per-run count for each `METHOD path`; a run without the endpoint counts as 0. */
  readonly endpoints: Record<string, number>;
  readonly externalCalls: number;
  /** Runs whose span-derived API call count differs from the replay server's request log. */
  readonly logMismatchRuns: number;
  readonly errorStatuses: number;
}

export interface BuildAnalysis {
  readonly timing: TimingSummary;
  readonly samples: number;
  readonly exitCodes: ReadonlyArray<number>;
  readonly tracedExitCodes: ReadonlyArray<number>;
  readonly spans: Record<string, SpanAggregate> | undefined;
  readonly api: ApiSummary | undefined;
  /** Measured runs without a usable trace when tracing was requested. */
  readonly traceMissingRuns: number;
  readonly skippedTraceLines: number;
}

function summarizeApi(samples: ReadonlyArray<RunSample>): ApiSummary | undefined {
  const apis = samples.flatMap((sample) =>
    sample.trace?.api === undefined ? [] : [sample.trace.api],
  );
  if (apis.length === 0) return undefined;
  const runCalls = apis.map((api) => api.apiCalls);
  const keys = new Set(apis.flatMap((api) => Object.keys(api.endpoints)));
  const endpoints: Record<string, number> = {};
  for (const key of keys) endpoints[key] = median(apis.map((api) => api.endpoints[key] ?? 0));
  const shape = (api: (typeof apis)[number]) =>
    JSON.stringify(Object.entries(api.endpoints).sort(([a], [b]) => a.localeCompare(b)));
  return {
    medianCalls: median(runCalls),
    runCalls,
    nonDeterministic: new Set(apis.map(shape)).size > 1,
    endpoints,
    externalCalls: Math.max(...apis.map((api) => api.externalCalls)),
    logMismatchRuns: apis.filter((api) => api.apiCalls !== api.requestLogCount).length,
    errorStatuses: Math.max(...apis.map((api) => api.errorStatuses)),
  };
}

function summarizeBuild(samples: ReadonlyArray<RunSample>, traced: boolean): BuildAnalysis {
  const withTrace = samples.flatMap((sample) => (sample.trace === undefined ? [] : [sample.trace]));
  return {
    timing: summarizeTimings(samples.map((sample) => sample.wallMs)),
    samples: samples.length,
    exitCodes: samples.map((sample) => sample.exitCode),
    tracedExitCodes: samples.flatMap((sample) =>
      sample.tracedExitCode === undefined ? [] : [sample.tracedExitCode],
    ),
    spans: traced ? aggregateSpanRuns(withTrace.map((trace) => trace.spans)) : undefined,
    api: summarizeApi(samples),
    traceMissingRuns: traced ? samples.length - withTrace.length : 0,
    skippedTraceLines: withTrace.reduce((sum, trace) => sum + trace.skippedLines, 0),
  };
}

export interface EndpointChange {
  readonly endpoint: string;
  readonly base: number;
  readonly branch: number;
}

export interface WorkloadAnalysis {
  readonly id: string;
  readonly args: ReadonlyArray<string>;
  readonly base: BuildAnalysis;
  readonly branch: BuildAnalysis;
  readonly deltaMs: number;
  readonly deltaPct: number;
  readonly verdict: TimingVerdict;
  readonly exitCodesDiffer: boolean;
  readonly spans: ReadonlyArray<SpanComparison> | undefined;
  /** Top phase deltas; empty unless the verdict is "slower" or "faster". */
  readonly phaseRows: ReadonlyArray<SpanComparison>;
  readonly endpointChanges: ReadonlyArray<EndpointChange>;
}

/** Whether every launch of the workload exited 0 and every API call got a non-error response. */
function runsCleanly(build: BuildAnalysis): boolean {
  return (
    [...build.exitCodes, ...build.tracedExitCodes].every((code) => code === 0) &&
    (build.api?.errorStatuses ?? 0) === 0
  );
}

function endpointChanges(
  base: BuildAnalysis,
  branch: BuildAnalysis,
): ReadonlyArray<EndpointChange> {
  if (base.api === undefined || branch.api === undefined) return [];
  const baseEndpoints = base.api.endpoints;
  const branchEndpoints = branch.api.endpoints;
  const keys = new Set([...Object.keys(baseEndpoints), ...Object.keys(branchEndpoints)]);
  return [...keys]
    .sort()
    .map((endpoint) => ({
      endpoint,
      base: baseEndpoints[endpoint] ?? 0,
      branch: branchEndpoints[endpoint] ?? 0,
    }))
    .filter((change) => change.base !== change.branch);
}

/** Derives medians, comparisons and the timing verdict for one workload from its raw samples. */
export function analyzeWorkload(workload: WorkloadReport, traced: boolean): WorkloadAnalysis {
  const base = summarizeBuild(workload.base, traced);
  const branch = summarizeBuild(workload.branch, traced);
  const delta = deltaOf(base.timing.median, branch.timing.median);
  const differ = exitCodesDiffer(base.exitCodes, branch.exitCodes);
  const verdict = timingVerdict(base.timing, branch.timing, {
    comparable: !differ && runsCleanly(base) && runsCleanly(branch),
    samples: Math.min(base.samples, branch.samples),
  });
  const spans =
    base.spans === undefined || branch.spans === undefined
      ? undefined
      : compareSpans(base.spans, branch.spans);
  return {
    id: workload.id,
    args: workload.args,
    base,
    branch,
    deltaMs: delta.ms,
    deltaPct: delta.pct,
    verdict,
    exitCodesDiffer: differ,
    spans,
    phaseRows:
      verdict === "slower" || verdict === "faster" ? (spans ?? []).slice(0, PHASE_ROWS) : [],
    endpointChanges: endpointChanges(base, branch),
  };
}

export type FlagKind =
  | "new-api-calls"
  | "api-calls-dropped"
  | "external-calls"
  | "non-deterministic"
  | "request-log-mismatch"
  | "error-status"
  | "trace-incomplete"
  | "non-zero-exit"
  | "exit-codes-differ"
  | "traced-exit-differs"
  | "insufficient-samples";

export interface Flag {
  readonly workload: string;
  readonly kind: FlagKind;
  readonly detail: string;
  /** The build the flag is about, absent when it concerns the comparison. */
  readonly build?: Build;
}

/** Everything about a workload that makes its comparison suspect or notable beyond timing. */
export function collectFlags(analysis: WorkloadAnalysis): ReadonlyArray<Flag> {
  const flags: Array<Flag> = [];
  const add = (kind: FlagKind, detail: string, build?: Build) =>
    flags.push({ workload: analysis.id, kind, detail, ...(build === undefined ? {} : { build }) });
  const baseCalls = analysis.base.api?.medianCalls;
  const branchCalls = analysis.branch.api?.medianCalls;
  if (baseCalls === 0 && branchCalls !== undefined && branchCalls > 0) {
    add("new-api-calls", `base makes 0 API calls, branch makes ${branchCalls}`);
  }
  if (baseCalls !== undefined && baseCalls > 0 && branchCalls === 0) {
    add("api-calls-dropped", `base makes ${baseCalls} API calls, branch makes 0`);
  }
  if (Math.min(analysis.base.samples, analysis.branch.samples) < VERDICT_MIN_SAMPLES) {
    add(
      "insufficient-samples",
      `fewer than ${VERDICT_MIN_SAMPLES} measured runs, so no timing verdict`,
    );
  }
  if (analysis.exitCodesDiffer) {
    add("exit-codes-differ", "exit codes differ between builds, so timings are not comparable");
  }
  for (const build of ["base", "branch"] as const) {
    const summary = analysis[build];
    const failed = summary.exitCodes.filter((code) => code !== 0).length;
    if (failed > 0) {
      add("non-zero-exit", `${build} exited non-zero in ${failed}/${summary.samples} runs`, build);
    }
    const timed = new Set(summary.exitCodes);
    if (summary.tracedExitCodes.some((code) => !timed.has(code))) {
      add(
        "traced-exit-differs",
        `${build} traced launch exited differently from its timed launches`,
        build,
      );
    }
    if (summary.traceMissingRuns > 0 || summary.skippedTraceLines > 0) {
      add(
        "trace-incomplete",
        `${build} has ${summary.traceMissingRuns} runs without a trace and ${summary.skippedTraceLines} undecodable trace lines`,
        build,
      );
    }
    const api = summary.api;
    if (api === undefined) continue;
    if (api.externalCalls > 0) {
      add("external-calls", `${build} made calls to hosts other than the replay server`, build);
    }
    if (api.nonDeterministic) {
      add("non-deterministic", `${build} API calls differ between runs`, build);
    }
    if (api.logMismatchRuns > 0) {
      add(
        "request-log-mismatch",
        `${build} spans disagree with the replay request log in ${api.logMismatchRuns} runs`,
        build,
      );
    }
    if (api.errorStatuses > 0) {
      add(
        "error-status",
        `${build} got 4xx/5xx replay responses, so it did not follow the recorded scenario`,
        build,
      );
    }
  }
  return flags;
}
