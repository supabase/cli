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
  readonly iqr: number;
}

/** Interquartile range by nearest rank, so one extreme value at either end cannot move it. */
const iqr = (values: ReadonlyArray<number>): number =>
  percentile(values, 75) - percentile(values, 25);

export function summarizeTimings(values: ReadonlyArray<number>): TimingSummary {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: round(median(sorted)),
    min: round(sorted[0] ?? 0),
    max: round(sorted[sorted.length - 1] ?? 0),
    p90: round(percentile(sorted, 90)),
    iqr: round(iqr(sorted)),
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

const CliArgs = Schema.Array(Schema.String);

const Workload = Schema.Struct({
  id: Schema.NonEmptyString,
  args: CliArgs,
  cwdSetup: Schema.Literals(["none", "init"]),
  scenario: Schema.optionalKey(Schema.String),
  /** Untimed commands run with the build under test before the measured launches. */
  setup: Schema.optionalKey(Schema.Array(CliArgs)),
  /** Untimed commands that always run after the measured launches, even after a failure or timeout. */
  teardown: Schema.optionalKey(Schema.Array(CliArgs)),
  /** `run` repeats setup and teardown for every launch; `block` shares them across a block of launches. */
  setupScope: Schema.optionalKey(Schema.Literals(["run", "block"])),
  /** Launches with `SUPABASE_EXPERIMENTAL_STACK=1`. */
  stack: Schema.optionalKey(Schema.Boolean),
  /** Container runtime the workload exercises; stack workloads pass it to `stack start` themselves. */
  runtime: Schema.optionalKey(Schema.Literals(["docker", "native"])),
  /** Directory under the manifest's `fixtures/` copied into the project's `supabase/` directory after `init`. */
  fixture: Schema.optionalKey(Schema.NonEmptyString),
  /** Directory under `fixtures/` copied into `supabase/` after setup, so the launch finds changes setup has not applied. */
  fixtureAfterSetup: Schema.optionalKey(Schema.NonEmptyString),
  runs: Schema.optionalKey(Schema.Finite),
  warmup: Schema.optionalKey(Schema.Finite),
  /** Traced launches per build; defaults to one per measured run. */
  traceRuns: Schema.optionalKey(Schema.Finite),
  timeoutSeconds: Schema.optionalKey(Schema.Finite),
  /** Expected seconds for one pass of the workload over both builds, used to pack shards. */
  estimatedSeconds: Schema.optionalKey(Schema.Finite),
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
    const name = `workload "${workload.id}"`;
    if (seen.has(workload.id)) problems.push(`duplicate workload id "${workload.id}"`);
    seen.add(workload.id);
    if (workload.scenario !== undefined && context.apiUrl === undefined) {
      problems.push(`${name} names a scenario and needs --api-url`);
    }
    for (const field of ["runs", "warmup", "traceRuns", "timeoutSeconds"] as const) {
      const value = workload[field];
      const minimum = field === "warmup" || field === "traceRuns" ? 0 : 1;
      if (value !== undefined && (!Number.isInteger(value) || value < minimum)) {
        problems.push(`${name} has an invalid ${field}`);
      }
    }
    if (workload.fixtureAfterSetup !== undefined && workload.setupScope === "block") {
      problems.push(
        `${name} stages fixtureAfterSetup, which a block-scoped workload applies only once`,
      );
    }
    if (workload.estimatedSeconds !== undefined && !(workload.estimatedSeconds > 0)) {
      problems.push(`${name} has an invalid estimatedSeconds`);
    }
    if (workload.stack === true && workload.runtime === undefined) {
      problems.push(`${name} is a stack workload and needs a runtime`);
    }
    if (workload.stack === true && (workload.teardown?.length ?? 0) === 0) {
      problems.push(`${name} is a stack workload and needs a teardown that destroys its stack`);
    }
    if (workload.stack !== true && workload.runtime === "native") {
      problems.push(`${name} uses the native runtime, which only stack workloads support`);
    }
    for (const command of [workload.args, ...(workload.setup ?? [])]) {
      if (command[0] !== "stack" || command[1] !== "start" || workload.runtime === undefined) {
        continue;
      }
      const at = command.indexOf("--runtime");
      if (at === -1 || command[at + 1] !== workload.runtime) {
        problems.push(`${name} runs stack start without --runtime ${workload.runtime}`);
      }
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
  /** Block index of a launch from a block-scoped workload; absent for run-scoped launches. */
  block: Schema.optionalKey(Schema.Finite),
  exitCode: Schema.Finite,
  /** Exit code of the traced launch, recorded even when no spans could be decoded. */
  tracedExitCode: Schema.optionalKey(Schema.Finite),
  trace: Schema.optionalKey(TraceSample),
});
export type RunSample = typeof RunSample.Type;

const TeardownFailure = Schema.Struct({
  build: Schema.Literals(["base", "branch"]),
  /** The teardown step's arguments, space-joined. */
  command: Schema.String,
  exitCode: Schema.Finite,
});
export type TeardownFailure = typeof TeardownFailure.Type;

const WorkloadReport = Schema.Struct({
  id: Schema.String,
  args: Schema.Array(Schema.String),
  /** Container runtime the workload exercised, when it declares one. */
  runtime: Schema.optionalKey(Schema.Literals(["docker", "native"])),
  /** Whether the workload ran against the stack backend. */
  stack: Schema.optionalKey(Schema.Boolean),
  /** Traced launches expected per build; absent means one per measured run. */
  traceRuns: Schema.optionalKey(Schema.Finite),
  /** Wall seconds across both builds, including setup, teardown and traced launches. */
  elapsedSeconds: Schema.optionalKey(Schema.Finite),
  /** Teardown steps that exited non-zero, which can leave state behind for later units. */
  teardownFailures: Schema.optionalKey(Schema.Array(TeardownFailure)),
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
/** Paired blocks needed before the block, not the launch, is the unit of evidence for a verdict. */
export const VERDICT_MIN_BLOCKS = 3;
export const VERDICT_IQR_FACTOR = 1.5;
export const PHASE_ROWS = 3;

export type TimingVerdict = "slower" | "faster" | "within noise" | "not comparable";

/** Median wall time of one block for each build, paired by block index. */
export interface BlockPair {
  readonly base: number;
  readonly branch: number;
}

const exceedsFloor = (delta: Delta): boolean =>
  Math.abs(delta.pct) >= VERDICT_MIN_PCT && Math.abs(delta.ms) >= VERDICT_MIN_MS;

/**
 * "slower" or "faster" only when the median change passes the {@link VERDICT_MIN_PCT} percent and
 * {@link VERDICT_MIN_MS} ms floor and is larger than {@link VERDICT_IQR_FACTOR} times the wider
 * build's interquartile range, so one extreme sample cannot fake a change. Run-scoped timings
 * also need the branch median beyond the base range; with at least {@link VERDICT_MIN_BLOCKS}
 * paired blocks the spread test runs on block medians instead, and a strict majority of blocks
 * must pass the floor in the same direction.
 */
export function timingVerdict(
  base: TimingSummary,
  branch: TimingSummary,
  context: {
    readonly comparable: boolean;
    readonly samples: number;
    readonly blocks?: ReadonlyArray<BlockPair>;
  },
): TimingVerdict {
  if (!context.comparable || context.samples < VERDICT_MIN_SAMPLES) return "not comparable";
  const blocks = context.blocks;
  if (blocks !== undefined && blocks.length >= VERDICT_MIN_BLOCKS) {
    const baseMedians = blocks.map((block) => block.base);
    const branchMedians = blocks.map((block) => block.branch);
    const reference = median(baseMedians);
    const ms = median(blocks.map((block) => block.branch - block.base));
    const pct = reference === 0 ? 0 : (ms / reference) * 100;
    if (!exceedsFloor({ ms: round(ms), pct: round(pct) })) return "within noise";
    const agreeing = blocks.filter((block) => {
      const blockDelta = deltaOf(block.base, block.branch);
      return exceedsFloor(blockDelta) && blockDelta.ms > 0 === ms > 0;
    }).length;
    if (agreeing * 2 <= blocks.length) return "within noise";
    if (Math.abs(ms) <= VERDICT_IQR_FACTOR * Math.max(iqr(baseMedians), iqr(branchMedians))) {
      return "within noise";
    }
    return ms > 0 ? "slower" : "faster";
  }
  const delta = deltaOf(base.median, branch.median);
  if (!exceedsFloor(delta)) return "within noise";
  const outsideRange = delta.ms > 0 ? branch.median > base.max : branch.median < base.min;
  if (!outsideRange) return "within noise";
  if (Math.abs(delta.ms) <= VERDICT_IQR_FACTOR * Math.max(base.iqr, branch.iqr)) {
    return "within noise";
  }
  return delta.ms > 0 ? "slower" : "faster";
}

/** Pairs the per-block medians of both builds; empty unless every sample carries a block index. */
export function pairBlocks(
  base: ReadonlyArray<RunSample>,
  branch: ReadonlyArray<RunSample>,
): ReadonlyArray<BlockPair> {
  const group = (samples: ReadonlyArray<RunSample>): Map<number, Array<number>> | undefined => {
    const blocks = new Map<number, Array<number>>();
    for (const sample of samples) {
      if (sample.block === undefined) return undefined;
      blocks.set(sample.block, [...(blocks.get(sample.block) ?? []), sample.wallMs]);
    }
    return blocks;
  };
  const baseBlocks = group(base);
  const branchBlocks = group(branch);
  if (baseBlocks === undefined || branchBlocks === undefined) return [];
  return [...baseBlocks.entries()].flatMap(([block, values]) => {
    const other = branchBlocks.get(block);
    return other === undefined ? [] : [{ base: median(values), branch: median(other) }];
  });
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
  /** Median container CLI calls per run by verb, summed over `ContainerCli.spawn` and `ContainerCli.run`. */
  readonly containers: Record<string, number> | undefined;
  /** Traced runs expected but without a usable trace when tracing was requested. */
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

const CONTAINER_SPAN = /^ContainerCli\.(?:spawn|run)(?: \((.+)\))?$/u;

/** Median per-run container CLI call counts keyed by verb; empty when no container call ran. */
export function containerCounts(spans: Record<string, SpanAggregate>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [name, aggregate] of Object.entries(spans)) {
    const match = CONTAINER_SPAN.exec(name);
    if (match === null) continue;
    const verb = match[1] ?? "(unlabelled)";
    counts[verb] = (counts[verb] ?? 0) + aggregate.medianCount;
  }
  return counts;
}

function summarizeBuild(
  samples: ReadonlyArray<RunSample>,
  traced: boolean,
  expectedTraces: number,
  countContainers: boolean,
): BuildAnalysis {
  const withTrace = samples.flatMap((sample) => (sample.trace === undefined ? [] : [sample.trace]));
  const spans = traced ? aggregateSpanRuns(withTrace.map((trace) => trace.spans)) : undefined;
  return {
    timing: summarizeTimings(samples.map((sample) => sample.wallMs)),
    samples: samples.length,
    exitCodes: samples.map((sample) => sample.exitCode),
    tracedExitCodes: samples.flatMap((sample) =>
      sample.tracedExitCode === undefined ? [] : [sample.tracedExitCode],
    ),
    spans,
    api: summarizeApi(samples),
    containers:
      spans === undefined || !countContainers || withTrace.length === 0
        ? undefined
        : containerCounts(spans),
    traceMissingRuns: traced ? Math.max(0, expectedTraces - withTrace.length) : 0,
    skippedTraceLines: withTrace.reduce((sum, trace) => sum + trace.skippedLines, 0),
  };
}

export interface EndpointChange {
  readonly endpoint: string;
  readonly base: number;
  readonly branch: number;
}

export interface ContainerChange {
  readonly verb: string;
  readonly base: number;
  readonly branch: number;
}

export interface WorkloadAnalysis {
  readonly id: string;
  readonly args: ReadonlyArray<string>;
  readonly runtime: "docker" | "native" | undefined;
  readonly stack: boolean;
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
  /** Container verbs whose per-run call count differs between builds. */
  readonly containerChanges: ReadonlyArray<ContainerChange>;
  readonly teardownFailures: ReadonlyArray<TeardownFailure>;
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

function containerChanges(
  base: BuildAnalysis,
  branch: BuildAnalysis,
): ReadonlyArray<ContainerChange> {
  if (base.containers === undefined || branch.containers === undefined) return [];
  const verbs = new Set([...Object.keys(base.containers), ...Object.keys(branch.containers)]);
  return [...verbs]
    .sort()
    .map((verb) => ({
      verb,
      base: base.containers?.[verb] ?? 0,
      branch: branch.containers?.[verb] ?? 0,
    }))
    .filter((change) => change.base !== change.branch);
}

/** Total container CLI calls per run, or undefined when container calls were not traced. */
export function totalContainerCalls(build: BuildAnalysis): number | undefined {
  return build.containers === undefined
    ? undefined
    : Object.values(build.containers).reduce((sum, count) => sum + count, 0);
}

/** Derives medians, comparisons and the timing verdict for one workload from its raw samples. */
export function analyzeWorkload(workload: WorkloadReport, traced: boolean): WorkloadAnalysis {
  const expectedTraces = (samples: number) => Math.min(workload.traceRuns ?? samples, samples);
  // Stack backend container work runs in a detached owner process, so its spans never reach the CLI's trace.
  const countContainers = workload.stack !== true;
  const base = summarizeBuild(
    workload.base,
    traced,
    expectedTraces(workload.base.length),
    countContainers,
  );
  const branch = summarizeBuild(
    workload.branch,
    traced,
    expectedTraces(workload.branch.length),
    countContainers,
  );
  const delta = deltaOf(base.timing.median, branch.timing.median);
  const differ = exitCodesDiffer(base.exitCodes, branch.exitCodes);
  const verdict = timingVerdict(base.timing, branch.timing, {
    comparable: !differ && runsCleanly(base) && runsCleanly(branch),
    samples: Math.min(base.samples, branch.samples),
    blocks: pairBlocks(workload.base, workload.branch),
  });
  const spans =
    base.spans === undefined || branch.spans === undefined
      ? undefined
      : compareSpans(base.spans, branch.spans);
  return {
    id: workload.id,
    args: workload.args,
    runtime: workload.runtime,
    stack: workload.stack ?? false,
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
    containerChanges: containerChanges(base, branch),
    teardownFailures: workload.teardownFailures ?? [],
  };
}

export type FlagKind =
  | "new-api-calls"
  | "api-calls-dropped"
  | "new-container-calls"
  | "container-calls-dropped"
  | "container-calls-changed"
  | "external-calls"
  | "non-deterministic"
  | "request-log-mismatch"
  | "error-status"
  | "trace-incomplete"
  | "non-zero-exit"
  | "exit-codes-differ"
  | "traced-exit-differs"
  | "insufficient-samples"
  | "teardown-failed";

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
  const baseContainers = totalContainerCalls(analysis.base);
  const branchContainers = totalContainerCalls(analysis.branch);
  if (baseContainers !== undefined && branchContainers !== undefined) {
    if (baseContainers === 0 && branchContainers > 0) {
      add("new-container-calls", `base makes 0 container calls, branch makes ${branchContainers}`);
    } else if (baseContainers > 0 && branchContainers === 0) {
      add(
        "container-calls-dropped",
        `base makes ${baseContainers} container calls, branch makes 0`,
      );
    } else if (analysis.containerChanges.length > 0) {
      add(
        "container-calls-changed",
        `container calls changed from ${baseContainers} to ${branchContainers}`,
      );
    }
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
    const failures = analysis.teardownFailures.filter((failure) => failure.build === build);
    if (failures.length > 0) {
      add(
        "teardown-failed",
        failures.map((failure) => `\`${failure.command}\` exited ${failure.exitCode}`).join(", "),
        build,
      );
    }
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
