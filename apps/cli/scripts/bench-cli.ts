/**
 * A/B wall-time benchmark for two CLI binaries. Alternates launches between `--base` and
 * `--branch` so neither build runs consistently warmer, isolates each launch's environment, and
 * optionally records per-span trace totals and Management API call counts from
 * `SUPABASE_TRACE_FILE` tracing. Run as
 * `bun scripts/bench-cli.ts --base <path> --branch <path> [options]`.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import process from "node:process";
import { parseArgs } from "node:util";
import { BunPath, BunRuntime, BunServices } from "@effect/platform-bun";
import { Clock, Console, Effect, FileSystem, Layer, Option, Path, Ref, Stdio } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  analyzeWorkload,
  BenchReport,
  classifyHttpSpans,
  encodeBenchReport,
  collectFlags,
  parseWorkloadManifest,
  summarizeSpanRun,
  validateWorkloads,
  type Build,
  type RunSample,
  type SpanComparison,
  type Workload,
  type WorkloadAnalysis,
  type WorkloadReport,
} from "./bench-report.ts";
import { readRequestLogCount, resetReplay } from "./replay-control.ts";
import { readSpans } from "./trace-report.ts";

const USAGE =
  'usage: bun scripts/bench-cli.ts --base <path> --branch <path> [--runs N] [--warmup N] [--command "<args>"]... [--workloads <file.json>] [--api-url <url>] [--cwd-setup init] [--trace] [--json] [--out <file>] [--cpu-prof] [--update-check]\n' +
  "  --command splits on whitespace; it does not support shell quoting. Use --workloads for quoted arguments.\n" +
  "  --workloads reads a manifest of workloads and cannot be combined with --command or --cwd-setup.\n" +
  "  --api-url points every launch at a replay server through a profile file, and counts Management API calls from the traced launches; it requires --trace.\n" +
  "  --update-check keeps the GitHub release check, which otherwise adds network time to every launch.";

export interface BenchOptions {
  readonly base: string;
  readonly branch: string;
  readonly runs: number;
  readonly warmup: number;
  readonly commands: ReadonlyArray<ReadonlyArray<string>>;
  readonly workloadsFile: string | undefined;
  readonly cwdSetupInit: boolean;
  readonly apiUrl: string | undefined;
  readonly trace: boolean;
  readonly json: boolean;
  readonly out: string | undefined;
  readonly cpuProf: boolean;
  readonly updateCheck: boolean;
}

const DEFAULT_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [["--version"], ["--help"]];

/** Dummy token for launches pointed at a replay server; it never reaches a real API. */
const BENCH_ACCESS_TOKEN = `sbp_${"0".repeat(40)}`;

/** Whether `--help`/`-h` is passed as a flag rather than as a `--command` value. */
export function wantsHelp(argv: ReadonlyArray<string>): boolean {
  return argv.some(
    (arg, index) => (arg === "--help" || arg === "-h") && argv[index - 1] !== "--command",
  );
}

/** Parses argv into {@link BenchOptions}; throws on missing `--base`/`--branch` or bad values. */
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
      workloads: { type: "string" },
      "api-url": { type: "string" },
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
  const hasCommands = values.command !== undefined && values.command.length > 0;
  if (values.workloads !== undefined && (hasCommands || values["cwd-setup"] !== undefined)) {
    throw new Error("--workloads cannot be combined with --command or --cwd-setup");
  }
  if (values["api-url"] !== undefined) {
    if (!URL.canParse(values["api-url"])) throw new Error("--api-url must be a valid URL");
    if (!values.trace)
      throw new Error("--api-url requires --trace, which supplies the call counts");
  }

  /* The host `Path` service (`node:path` itself), read synchronously for this sync parser. */
  const hostPath = Effect.runSync(
    Path.Path.useSync((path) => path).pipe(Effect.provide(BunPath.layer)),
  );
  return {
    // Each launch spawns with a per-run `cwd`, which also resolves a relative command path; a
    // path given relative to the invocation directory must become absolute before that happens.
    base: hostPath.resolve(values.base),
    branch: hostPath.resolve(values.branch),
    runs,
    warmup,
    commands: hasCommands
      ? values.command!.map((raw) => raw.split(/\s+/u).filter((part) => part.length > 0))
      : DEFAULT_COMMANDS,
    workloadsFile: values.workloads,
    cwdSetupInit: values["cwd-setup"] === "init",
    apiUrl: values["api-url"],
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

/** Launches base and branch once per iteration, swapping which goes first on every other measured iteration. */
export function buildRunPlan(runs: number, warmup: number): ReadonlyArray<PlannedRun> {
  const plan: Array<PlannedRun> = [];
  for (let iteration = 0; iteration < runs + warmup; iteration++) {
    const isWarmup = iteration < warmup;
    const order: ReadonlyArray<Build> =
      Math.abs(iteration - warmup) % 2 === 0 ? ["base", "branch"] : ["branch", "base"];
    for (const build of order) plan.push({ build, warmup: isWarmup, iteration });
  }
  return plan;
}

/** The workloads for a run: the manifest entries, or one per `--command` with `--cwd-setup`. */
export const resolveWorkloads = Effect.fn("BenchCli.resolveWorkloads")(function* (
  options: BenchOptions,
) {
  const workloads: ReadonlyArray<Workload> =
    options.workloadsFile === undefined
      ? options.commands.map((args) => ({
          id: args.join(" ") || "(no args)",
          args,
          cwdSetup: options.cwdSetupInit ? ("init" as const) : ("none" as const),
        }))
      : yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* parseWorkloadManifest(yield* fs.readFileString(options.workloadsFile!));
        });
  const problems = validateWorkloads(workloads, { apiUrl: options.apiUrl });
  if (problems.length > 0) return yield* Effect.fail(problems.join("\n"));
  return workloads;
});

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

const PROFILE_FILE = "bench-profile.yaml";

/** A profile naming `apiUrl` as the Management API; the profile is the CLI's only API redirect. */
export function profileYaml(apiUrl: string): string {
  return [
    "name: bench",
    `api_url: "${apiUrl}"`,
    `dashboard_url: "${apiUrl}"`,
    "project_host: localhost",
    "",
  ].join("\n");
}

const baseLaunchEnv = (
  options: BenchOptions,
  supabaseHome: string,
  profilePath: string,
): Record<string, string> => ({
  SUPABASE_HOME: supabaseHome,
  DO_NOT_TRACK: "1",
  SUPABASE_NO_KEYRING: "1",
  ...(options.updateCheck ? {} : { SUPABASE_NO_UPDATE_NOTIFIER: "1" }),
  ...(options.apiUrl === undefined
    ? {}
    : {
        SUPABASE_PROFILE: profilePath,
        SUPABASE_ACCESS_TOKEN: BENCH_ACCESS_TOKEN,
        SUPABASE_TELEMETRY_DISABLED: "1",
        // With a pooler-url file present, a set password skips the interactive login-role flow.
        SUPABASE_DB_PASSWORD: "bench-placeholder-password",
      }),
});

/**
 * A fresh project directory and `SUPABASE_HOME`, with the replay profile written and the
 * workload's `cwdSetup` applied.
 */
const prepareLaunch = (options: BenchOptions, workload: Workload, binary: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-bench-cwd-" });
    const supabaseHome = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-bench-home-" });
    const profilePath = path.join(supabaseHome, PROFILE_FILE);
    if (options.apiUrl !== undefined) {
      yield* fs.writeFileString(profilePath, profileYaml(options.apiUrl));
    }
    const env = baseLaunchEnv(options, supabaseHome, profilePath);
    if (workload.cwdSetup !== "none") {
      const init = yield* runLaunch({
        binary,
        args: ["init"],
        cwd: projectDir,
        env: isolatedEnv(process.env, env),
      });
      if (init.exitCode !== 0) {
        yield* Console.error(
          `warning: ${binary} init exited ${init.exitCode} in ${projectDir}; the run may not reflect a real project`,
        );
      }
    }
    if (workload.cwdSetup === "linked" && workload.projectRef !== undefined) {
      const tempDir = path.join(projectDir, "supabase", ".temp");
      yield* fs.makeDirectory(tempDir, { recursive: true });
      yield* fs.writeFileString(path.join(tempDir, "project-ref"), workload.projectRef);
      yield* fs.writeFileString(
        path.join(tempDir, "pooler-url"),
        `postgresql://postgres.${workload.projectRef}:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,
      );
    }
    return { projectDir, env };
  });

export const runWorkloadBench = (
  options: BenchOptions,
  workload: Workload,
  profiled: Ref.Ref<boolean>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const plan = buildRunPlan(options.runs, options.warmup);

    const samples: Record<Build, Array<RunSample>> = { base: [], branch: [] };
    let cpuProfilePath: string | undefined;

    // Resets the replay server after setup, so setup's own requests and a previous launch's
    // consumed scenario never reach the launch that follows.
    const resetServer =
      options.apiUrl === undefined ? Effect.void : resetReplay(options.apiUrl, workload.scenario);

    for (const planned of plan) {
      const binary = planned.build === "base" ? options.base : options.branch;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const prepared = yield* prepareLaunch(options, workload, binary);
          yield* resetServer;
          const result = yield* runLaunch({
            binary,
            args: workload.args,
            cwd: prepared.projectDir,
            env: isolatedEnv(process.env, prepared.env),
          });

          if (planned.warmup) return;

          // Tracing and profiling slow the launch they observe, so they run in an extra, untimed
          // launch in fresh directories. Both builds get traced launches; only one branch launch
          // is profiled.
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

          let trace: RunSample["trace"];
          if (traceFile !== undefined || bunOptions !== undefined) {
            const observed = yield* prepareLaunch(options, workload, binary);
            yield* resetServer;
            const traced = yield* runLaunch({
              binary,
              args: workload.args,
              cwd: observed.projectDir,
              env: isolatedEnv(process.env, {
                ...observed.env,
                ...(traceFile === undefined ? {} : { SUPABASE_TRACE_FILE: traceFile }),
                ...(bunOptions === undefined ? {} : { BUN_OPTIONS: bunOptions }),
              }),
            });
            if (traceFile !== undefined) {
              const requestLogCount =
                options.apiUrl === undefined
                  ? undefined
                  : yield* readRequestLogCount(options.apiUrl);
              // Trace data is optional; a missing or unreadable file must not discard timings.
              const decoded = yield* readSpans(traceFile).pipe(Effect.option);
              if (Option.isSome(decoded) && decoded.value.spans.length > 0) {
                const { spans, skippedLines } = decoded.value;
                const http =
                  options.apiUrl === undefined
                    ? undefined
                    : classifyHttpSpans(spans, options.apiUrl);
                trace = {
                  exitCode: traced.exitCode,
                  skippedLines,
                  spans: summarizeSpanRun(spans),
                  ...(http === undefined || requestLogCount === undefined
                    ? {}
                    : { api: { ...http, requestLogCount } }),
                };
              }
            }
          }

          samples[planned.build].push({
            wallMs: result.wallMs,
            exitCode: result.exitCode,
            ...(trace === undefined ? {} : { trace }),
          });
        }),
      );
    }

    const report: WorkloadReport = {
      id: workload.id,
      args: workload.args,
      base: samples.base,
      branch: samples.branch,
    };
    return { report, cpuProfilePath };
  });

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

function formatWorkload(analysis: WorkloadAnalysis): ReadonlyArray<string> {
  const sign = (value: number) => (value >= 0 ? "+" : "");
  const line = (label: string, build: WorkloadAnalysis["base"]) =>
    `  ${label} median ${build.timing.median}ms  min ${build.timing.min}ms  max ${build.timing.max}ms  p90 ${build.timing.p90}ms  exits [${build.exitCodes.join(",")}]`;
  const lines = [
    `command: ${analysis.args.join(" ") || "(no args)"}  [${analysis.id}]`,
    line("base:  ", analysis.base),
    line("branch:", analysis.branch),
    `  delta:  ${sign(analysis.deltaMs)}${analysis.deltaMs}ms (${sign(analysis.deltaPct)}${analysis.deltaPct}%)  ${analysis.verdict}`,
  ];
  if (analysis.base.api !== undefined || analysis.branch.api !== undefined) {
    lines.push(
      `  api calls: base ${analysis.base.api?.medianCalls ?? "n/a"}  branch ${analysis.branch.api?.medianCalls ?? "n/a"}`,
    );
    for (const change of analysis.endpointChanges) {
      lines.push(`    ${change.endpoint}  base ${change.base}  branch ${change.branch}`);
    }
  }
  for (const flag of collectFlags(analysis)) lines.push(`  warning: ${flag.detail}`);
  if (analysis.spans !== undefined && analysis.spans.length > 0) {
    lines.push("  spans (delta ms, or one-sided median ms x count):");
    for (const span of analysis.spans) lines.push(formatSpanLine(span));
  }
  lines.push("");
  return lines;
}

function formatReport(report: BenchReport): string {
  const lines = [
    `base:   ${report.base}`,
    `branch: ${report.branch}`,
    `runs: ${report.runs}  warmup: ${report.warmup}` +
      (report.apiUrl === undefined ? "" : `  api-url: ${report.apiUrl}`),
    "",
  ];
  for (const workload of report.workloads) {
    lines.push(...formatWorkload(analyzeWorkload(workload, report.trace)));
  }
  if (report.cpuProfilePath !== undefined) {
    lines.push(`cpu profile (one untimed branch launch): ${report.cpuProfilePath}`);
  }
  return lines.join("\n");
}

const fileSize = (binary: string) =>
  FileSystem.FileSystem.use((fs) => fs.stat(binary)).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.option,
    Effect.map(Option.getOrUndefined),
  );

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

  const workloads = yield* resolveWorkloads(options);
  const profiled = yield* Ref.make(false);
  const reports: Array<WorkloadReport> = [];
  let cpuProfilePath: string | undefined;

  for (const workload of workloads) {
    const result = yield* runWorkloadBench(options, workload, profiled);
    reports.push(result.report);
    if (result.cpuProfilePath !== undefined) cpuProfilePath = result.cpuProfilePath;
  }

  const baseSizeBytes = yield* fileSize(options.base);
  const branchSizeBytes = yield* fileSize(options.branch);
  const report: BenchReport = {
    base: options.base,
    branch: options.branch,
    ...(baseSizeBytes === undefined ? {} : { baseSizeBytes }),
    ...(branchSizeBytes === undefined ? {} : { branchSizeBytes }),
    runs: options.runs,
    warmup: options.warmup,
    trace: options.trace,
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    workloads: reports,
    ...(cpuProfilePath === undefined ? {} : { cpuProfilePath }),
  };

  if (options.out !== undefined) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(options.out, yield* encodeBenchReport(report));
  }

  yield* Console.log(options.json ? yield* encodeBenchReport(report) : formatReport(report));
});

if (import.meta.main) {
  BunRuntime.runMain(
    main.pipe(Effect.provide(Layer.mergeAll(FetchHttpClient.layer, BunServices.layer))),
  );
}
