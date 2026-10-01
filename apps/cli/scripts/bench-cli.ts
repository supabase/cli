/**
 * A/B wall-time benchmark for two CLI binaries. Alternates launches between `--base` and
 * `--branch` so neither build runs consistently warmer, isolates each launch's environment, and
 * optionally compares per-span trace totals when `SUPABASE_TRACE_FILE` tracing is available. Run
 * as `bun scripts/bench-cli.ts --base <path> --branch <path> [options]`.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Clock, Console, Effect, FileSystem, Path, Ref, Stdio } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { readSpans, type ReportSpan } from "./trace-report.ts";

const USAGE =
  'usage: bun scripts/bench-cli.ts --base <path> --branch <path> [--runs N] [--warmup N] [--command "<args>"]... [--cwd-setup init] [--trace] [--json] [--out <file>] [--cpu-prof] [--update-check]\n' +
  "  --command splits on whitespace; it does not support shell quoting.\n" +
  "  --update-check keeps the GitHub release check, which otherwise adds network time to every launch.";

export type Build = "base" | "branch";

export interface BenchOptions {
  readonly base: string;
  readonly branch: string;
  readonly runs: number;
  readonly warmup: number;
  readonly commands: ReadonlyArray<ReadonlyArray<string>>;
  readonly cwdSetupInit: boolean;
  readonly trace: boolean;
  readonly json: boolean;
  readonly out: string | undefined;
  readonly cpuProf: boolean;
  readonly updateCheck: boolean;
}

const DEFAULT_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [["--version"], ["--help"]];

/** Whether `--help`/`-h` is passed as a flag rather than as a `--command` value. */
export function wantsHelp(argv: ReadonlyArray<string>): boolean {
  return argv.some(
    (arg, index) => (arg === "--help" || arg === "-h") && argv[index - 1] !== "--command",
  );
}

/** Parses argv into {@link BenchOptions}; throws on missing `--base`/`--branch` or bad numbers. */
export function parseBenchArgs(argv: ReadonlyArray<string>): BenchOptions {
  // `parseArgs` rejects a separate value that starts with `-`, but CLI commands usually do.
  const args: Array<string> = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = argv[index + 1];
    if (arg === "--command" && value !== undefined) {
      args.push(`--command=${value}`);
      index++;
    } else {
      args.push(arg);
    }
  }
  const { values } = parseArgs({
    args,
    options: {
      base: { type: "string" },
      branch: { type: "string" },
      runs: { type: "string", default: "10" },
      warmup: { type: "string", default: "2" },
      command: { type: "string", multiple: true },
      "cwd-setup": { type: "string" },
      trace: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      out: { type: "string" },
      "cpu-prof": { type: "boolean", default: false },
      "update-check": { type: "boolean", default: false },
    },
  });

  if (values.base === undefined || values.branch === undefined) {
    throw new Error(USAGE);
  }
  const runs = Number(values.runs);
  const warmup = Number(values.warmup);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  if (!Number.isInteger(warmup) || warmup < 0) {
    throw new Error("--warmup must be a non-negative integer");
  }
  if (values["cwd-setup"] !== undefined && values["cwd-setup"] !== "init") {
    throw new Error('--cwd-setup only supports "init"');
  }

  return {
    // Each launch spawns with a per-run `cwd`, which also resolves a relative command path; a
    // path given relative to the invocation directory must become absolute before that happens.
    base: resolvePath(values.base),
    branch: resolvePath(values.branch),
    runs,
    warmup,
    commands:
      values.command === undefined || values.command.length === 0
        ? DEFAULT_COMMANDS
        : values.command.map((raw) => raw.split(/\s+/u).filter((part) => part.length > 0)),
    cwdSetupInit: values["cwd-setup"] === "init",
    trace: values.trace ?? false,
    json: values.json ?? false,
    out: values.out,
    cpuProf: values["cpu-prof"] ?? false,
    updateCheck: values["update-check"] ?? false,
  };
}

const ENV_PREFIX = /^(?:SUPABASE_|OTEL_)/u;

/**
 * Starts from `ambient`, drops every `SUPABASE_*`/`OTEL_*` variable and `TRACEPARENT` so no
 * consent, trace, or endpoint state leaks between launches, then applies `overrides`.
 */
export function isolatedEnv(
  ambient: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (key === "TRACEPARENT" || ENV_PREFIX.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

export interface PlannedRun {
  readonly build: Build;
  readonly warmup: boolean;
  readonly iteration: number;
}

/** Alternates base/branch launches per iteration; the first `warmup` iterations are discarded. */
export function buildRunPlan(runs: number, warmup: number): ReadonlyArray<PlannedRun> {
  const plan: Array<PlannedRun> = [];
  for (let iteration = 0; iteration < runs + warmup; iteration++) {
    const isWarmup = iteration < warmup;
    plan.push({ build: "base", warmup: isWarmup, iteration });
    plan.push({ build: "branch", warmup: isWarmup, iteration });
  }
  return plan;
}

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

export interface SpanRunSummary {
  readonly totalMs: number;
  readonly count: number;
}

/** Sums duration and counts occurrences of each span name within one run's decoded spans. */
export function summarizeSpanRun(spans: ReadonlyArray<ReportSpan>): Record<string, SpanRunSummary> {
  const result: Record<string, SpanRunSummary> = {};
  for (const span of spans) {
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

interface BuildTimingSummary extends TimingSummary {
  readonly exitCodes: ReadonlyArray<number>;
}

export interface CommandReport {
  readonly command: ReadonlyArray<string>;
  readonly base: BuildTimingSummary;
  readonly branch: BuildTimingSummary;
  readonly deltaMs: number;
  readonly deltaPct: number;
  readonly spans: ReadonlyArray<SpanComparison> | undefined;
  readonly traceEmptyFor: ReadonlyArray<Build>;
  readonly exitCodesDiffer: boolean;
}

interface RawSample {
  readonly command: ReadonlyArray<string>;
  readonly build: Build;
  readonly wallMs: number;
  readonly exitCode: number;
  readonly spans: Record<string, SpanRunSummary> | undefined;
}

interface LaunchResult {
  readonly wallMs: number;
  readonly exitCode: number;
}

const runLaunch = (params: {
  readonly binary: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const start = yield* Clock.currentTimeNanos;
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(params.binary, params.args, {
        cwd: params.cwd,
        env: params.env,
        extendEnv: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    const end = yield* Clock.currentTimeNanos;
    return {
      wallMs: Number(end - start) / 1_000_000,
      exitCode: Number(exitCode),
    } satisfies LaunchResult;
  });

const baseLaunchEnv = (supabaseHome: string, updateCheck: boolean): Record<string, string> => ({
  SUPABASE_HOME: supabaseHome,
  DO_NOT_TRACK: "1",
  SUPABASE_NO_KEYRING: "1",
  ...(updateCheck ? {} : { SUPABASE_NO_UPDATE_NOTIFIER: "1" }),
});

/** A fresh project directory and `SUPABASE_HOME`, initialized when `--cwd-setup init` is set. */
const prepareLaunch = (options: BenchOptions, binary: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-bench-cwd-" });
    const supabaseHome = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-bench-home-" });
    if (options.cwdSetupInit) {
      const init = yield* runLaunch({
        binary,
        args: ["init"],
        cwd: projectDir,
        env: isolatedEnv(process.env, baseLaunchEnv(supabaseHome, options.updateCheck)),
      });
      if (init.exitCode !== 0) {
        yield* Console.error(
          `warning: ${binary} init exited ${init.exitCode} in ${projectDir}; the run may not reflect a real project`,
        );
      }
    }
    return { projectDir, supabaseHome };
  });

const runCommandBench = (
  options: BenchOptions,
  command: ReadonlyArray<string>,
  profiled: Ref.Ref<boolean>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const plan = buildRunPlan(options.runs, options.warmup);

    const samples: Record<Build, Array<number>> = { base: [], branch: [] };
    const exitCodes: Record<Build, Array<number>> = { base: [], branch: [] };
    const spanRuns: Record<Build, Array<Record<string, SpanRunSummary>>> = { base: [], branch: [] };
    const raw: Array<RawSample> = [];
    let cpuProfilePath: string | undefined;

    for (const planned of plan) {
      const binary = planned.build === "base" ? options.base : options.branch;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { projectDir, supabaseHome } = yield* prepareLaunch(options, binary);
          const result = yield* runLaunch({
            binary,
            args: command,
            cwd: projectDir,
            env: isolatedEnv(process.env, baseLaunchEnv(supabaseHome, options.updateCheck)),
          });

          if (planned.warmup) return;

          samples[planned.build].push(result.wallMs);
          exitCodes[planned.build].push(result.exitCode);

          // Tracing and profiling slow the launch they observe, so they run in an extra, untimed
          // launch in fresh directories that both builds receive equally.
          const traceFile = options.trace
            ? yield* fs.makeTempFileScoped({ prefix: "supabase-bench-trace-", suffix: ".jsonl" })
            : undefined;
          let bunOptions: string | undefined;
          if (options.cpuProf && planned.build === "branch") {
            const alreadyProfiled = yield* Ref.getAndSet(profiled, true);
            if (!alreadyProfiled) {
              const profileDir = tmpdir();
              const profileName = `supabase-bench-branch-${randomUUID()}.cpuprofile`;
              cpuProfilePath = path.join(profileDir, profileName);
              bunOptions = `--cpu-prof --cpu-prof-dir=${profileDir} --cpu-prof-name=${profileName}`;
            }
          }
          if (traceFile !== undefined || bunOptions !== undefined) {
            const observed = yield* prepareLaunch(options, binary);
            yield* runLaunch({
              binary,
              args: command,
              cwd: observed.projectDir,
              env: isolatedEnv(process.env, {
                ...baseLaunchEnv(observed.supabaseHome, options.updateCheck),
                ...(traceFile === undefined ? {} : { SUPABASE_TRACE_FILE: traceFile }),
                ...(bunOptions === undefined ? {} : { BUN_OPTIONS: bunOptions }),
              }),
            });
          }

          const spans =
            traceFile === undefined ? undefined : summarizeSpanRun(yield* readSpans(traceFile));
          if (spans !== undefined) spanRuns[planned.build].push(spans);

          raw.push({
            command,
            build: planned.build,
            wallMs: result.wallMs,
            exitCode: result.exitCode,
            spans,
          });
        }),
      );
    }

    const base = summarizeTimings(samples.base);
    const branch = summarizeTimings(samples.branch);
    const delta = deltaOf(base.median, branch.median);

    const spans = options.trace
      ? compareSpans(aggregateSpanRuns(spanRuns.base), aggregateSpanRuns(spanRuns.branch))
      : undefined;
    const traceEmptyFor: ReadonlyArray<Build> = options.trace
      ? (["base", "branch"] as const).filter(
          (build) =>
            spanRuns[build].length > 0 &&
            spanRuns[build].every((run) => Object.keys(run).length === 0),
        )
      : [];

    const report: CommandReport = {
      command,
      base: { ...base, exitCodes: exitCodes.base },
      branch: { ...branch, exitCodes: exitCodes.branch },
      deltaMs: delta.ms,
      deltaPct: delta.pct,
      spans,
      traceEmptyFor,
      exitCodesDiffer: exitCodesDiffer(exitCodes.base, exitCodes.branch),
    };
    return { report, raw, cpuProfilePath };
  });

interface Report {
  readonly base: string;
  readonly branch: string;
  readonly runs: number;
  readonly warmup: number;
  readonly trace: boolean;
  readonly cwdSetup: "init" | undefined;
  readonly commands: ReadonlyArray<CommandReport>;
  readonly cpuProfilePath: string | undefined;
}

function formatSpanLine(span: SpanComparison): string {
  if (span.onlyIn !== undefined) {
    const only = span.onlyIn === "base" ? span.base : span.branch;
    return `    ${span.onlyIn} only  ${span.name}  ${only?.medianMs}ms x${only?.medianCount}`;
  }
  const sign = (span.deltaMs ?? 0) >= 0 ? "+" : "";
  return (
    `    ${sign}${span.deltaMs}ms  ${span.name}  ` +
    `base ${span.base?.medianMs}ms x${span.base?.medianCount}  branch ${span.branch?.medianMs}ms x${span.branch?.medianCount}`
  );
}

function formatCommandReport(commandReport: CommandReport): ReadonlyArray<string> {
  const sign = (value: number) => (value >= 0 ? "+" : "");
  const lines = [
    `command: ${commandReport.command.join(" ") || "(no args)"}`,
    `  base:   median ${commandReport.base.median}ms  min ${commandReport.base.min}ms  max ${commandReport.base.max}ms  p90 ${commandReport.base.p90}ms  exits [${commandReport.base.exitCodes.join(",")}]`,
    `  branch: median ${commandReport.branch.median}ms  min ${commandReport.branch.min}ms  max ${commandReport.branch.max}ms  p90 ${commandReport.branch.p90}ms  exits [${commandReport.branch.exitCodes.join(",")}]`,
    `  delta:  ${sign(commandReport.deltaMs)}${commandReport.deltaMs}ms (${sign(commandReport.deltaPct)}${commandReport.deltaPct}%)`,
  ];
  if (commandReport.exitCodesDiffer) {
    lines.push("  warning: exit codes differ between builds, so the timings are not comparable");
  }
  for (const build of ["base", "branch"] as const) {
    const codes = commandReport[build].exitCodes;
    const failed = codes.filter((code) => code !== 0).length;
    if (failed > 0) {
      lines.push(
        `  warning: ${build} exited non-zero in ${failed}/${codes.length} runs, so its timings measure a failing invocation`,
      );
    }
  }
  if (commandReport.traceEmptyFor.length > 0) {
    lines.push(`  trace: no spans captured for ${commandReport.traceEmptyFor.join(", ")}`);
  }
  if (commandReport.spans !== undefined && commandReport.spans.length > 0) {
    lines.push("  spans (delta ms, or one-sided median ms x count):");
    for (const span of commandReport.spans) lines.push(formatSpanLine(span));
  }
  lines.push("");
  return lines;
}

function formatReport(report: Report): string {
  const lines = [
    `base:   ${report.base}`,
    `branch: ${report.branch}`,
    `runs: ${report.runs}  warmup: ${report.warmup}` +
      (report.cwdSetup === undefined ? "" : `  cwd-setup: ${report.cwdSetup}`),
    "",
  ];
  for (const commandReport of report.commands) lines.push(...formatCommandReport(commandReport));
  if (report.cpuProfilePath !== undefined) {
    lines.push(`cpu profile (one untimed branch launch): ${report.cpuProfilePath}`);
  }
  return lines.join("\n");
}

const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const argv = yield* stdio.args;
  if (wantsHelp(argv)) {
    yield* Console.log(USAGE);
    return;
  }
  const options = yield* Effect.try({
    try: () => parseBenchArgs(argv),
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  }).pipe(
    Effect.catch((message) =>
      Console.error(message === USAGE ? USAGE : `${message}\n${USAGE}`).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 2;
          }),
        ),
        Effect.as(undefined),
      ),
    ),
  );
  if (options === undefined) return;

  const profiled = yield* Ref.make(false);
  const commands: Array<CommandReport> = [];
  const samples: Array<RawSample> = [];
  let cpuProfilePath: string | undefined;

  for (const command of options.commands) {
    const result = yield* runCommandBench(options, command, profiled);
    commands.push(result.report);
    samples.push(...result.raw);
    if (result.cpuProfilePath !== undefined) cpuProfilePath = result.cpuProfilePath;
  }

  const report: Report = {
    base: options.base,
    branch: options.branch,
    runs: options.runs,
    warmup: options.warmup,
    trace: options.trace,
    cwdSetup: options.cwdSetupInit ? "init" : undefined,
    commands,
    cpuProfilePath,
  };

  if (options.out !== undefined) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(options.out, JSON.stringify({ report, samples }, null, 2));
  }

  yield* Console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
});

if (import.meta.main) {
  BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer)));
}
