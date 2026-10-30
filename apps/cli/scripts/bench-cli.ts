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
import {
  Clock,
  Console,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Stdio,
} from "effect";
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
  'usage: bun scripts/bench-cli.ts --base <path> --branch <path> [--runs N] [--warmup N] [--command "<args>"]... [--workloads <file.json>] [--only <ids>] [--runtime docker|native] [--artifact-cache <dir>] [--api-url <url>] [--cwd-setup init] [--trace] [--json] [--out <file>] [--cpu-prof] [--update-check]\n' +
  "  --command splits on whitespace; it does not support shell quoting. Use --workloads for quoted arguments.\n" +
  "  --workloads reads a manifest of workloads and cannot be combined with --command or --cwd-setup.\n" +
  "  --api-url points every launch at a replay server through a profile file, and counts Management API calls from the traced launches; it requires --trace.\n" +
  "  --only keeps the listed workload ids (comma separated); --runtime keeps workloads for that runtime, treating workloads with no runtime as docker.\n" +
  "  --artifact-cache links one directory in as the stack artifact cache of every launch's home, so native archives download once.\n" +
  "  --runs and --warmup, when given, override the per-workload values in a manifest.\n" +
  "  --update-check keeps the GitHub release check, which otherwise adds network time to every launch.";

export interface BenchOptions {
  readonly base: string;
  readonly branch: string;
  readonly runs: number;
  readonly warmup: number;
  /** Whether `--runs` was passed, which then overrides each workload's own `runs`. */
  readonly runsExplicit: boolean;
  readonly warmupExplicit: boolean;
  readonly commands: ReadonlyArray<ReadonlyArray<string>>;
  readonly workloadsFile: string | undefined;
  readonly only: ReadonlyArray<string> | undefined;
  readonly runtime: "docker" | "native" | undefined;
  readonly artifactCache: string | undefined;
  readonly cwdSetupInit: boolean;
  readonly apiUrl: string | undefined;
  readonly trace: boolean;
  readonly json: boolean;
  readonly out: string | undefined;
  readonly cpuProf: boolean;
  readonly updateCheck: boolean;
}

const DEFAULT_RUNS = 10;
const DEFAULT_WARMUP = 2;
/** The one variable a `stack: true` workload sets on its launches; it opens stack mode. */
const STACK_FLAG = "SUPABASE_EXPERIMENTAL_STACK";

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
      runs: { type: "string" },
      warmup: { type: "string" },
      command: { type: "string", multiple: true },
      workloads: { type: "string" },
      only: { type: "string" },
      runtime: { type: "string" },
      "artifact-cache": { type: "string" },
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
  const runs = Number(values.runs ?? DEFAULT_RUNS);
  const warmup = Number(values.warmup ?? DEFAULT_WARMUP);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  if (!Number.isInteger(warmup) || warmup < 0) {
    throw new Error("--warmup must be a non-negative integer");
  }
  if (values.runtime !== undefined && values.runtime !== "docker" && values.runtime !== "native") {
    throw new Error('--runtime must be "docker" or "native"');
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
    runsExplicit: values.runs !== undefined,
    warmupExplicit: values.warmup !== undefined,
    commands: hasCommands
      ? values.command!.map((raw) => raw.split(/\s+/u).filter((part) => part.length > 0))
      : DEFAULT_COMMANDS,
    workloadsFile: values.workloads,
    only:
      values.only === undefined ? undefined : values.only.split(",").filter((id) => id.length > 0),
    runtime: values.runtime,
    artifactCache:
      values["artifact-cache"] === undefined
        ? undefined
        : hostPath.resolve(values["artifact-cache"]),
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

export class WorkloadValidationError extends Schema.TaggedError<WorkloadValidationError>()(
  "WorkloadValidationError",
  { problems: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return this.problems.join("\n");
  }
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
  const problems = [...validateWorkloads(workloads, { apiUrl: options.apiUrl })];
  if (options.only !== undefined) {
    for (const id of options.only) {
      if (!workloads.some((workload) => workload.id === id)) {
        problems.push(`--only names unknown workload "${id}"`);
      }
    }
  }
  if (problems.length > 0) return yield* new WorkloadValidationError({ problems });
  return workloads.filter(
    (workload) =>
      (options.only === undefined || options.only.includes(workload.id)) &&
      (options.runtime === undefined || (workload.runtime ?? "docker") === options.runtime),
  );
});

interface LaunchResult {
  readonly wallMs: number;
  readonly exitCode: number;
}

/** Longest a single launch may run before it is killed and counted as a failed launch. */
export const LAUNCH_TIMEOUT_SECONDS = 60;
export const LAUNCH_TIMEOUT = Duration.seconds(LAUNCH_TIMEOUT_SECONDS);
/** Exit code recorded for a launch that hit {@link LAUNCH_TIMEOUT}. */
export const LAUNCH_TIMEOUT_EXIT_CODE = 124;

export const runLaunch = Effect.fn("BenchCli.runLaunch")(function* (params: {
  readonly binary: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly timeout?: Duration.Duration;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const start = yield* Clock.currentTimeNanos;
  const exit = yield* spawner
    .exitCode(
      ChildProcess.make(params.binary, params.args, {
        cwd: params.cwd,
        env: params.env,
        extendEnv: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(Effect.timeoutOption(params.timeout ?? LAUNCH_TIMEOUT));
  const end = yield* Clock.currentTimeNanos;
  if (Option.isNone(exit)) {
    yield* Console.error(
      `warning: ${params.binary} ${params.args.join(" ")} did not exit within ${Duration.format(params.timeout ?? LAUNCH_TIMEOUT)}; it was killed`,
    );
  }
  return {
    wallMs: Number(end - start) / 1_000_000,
    exitCode: Option.isSome(exit) ? Number(exit.value) : LAUNCH_TIMEOUT_EXIT_CODE,
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

/** Variables set on every launch: no product telemetry, no keyring, and no update check unless asked. */
const baseLaunchEnv = (
  options: BenchOptions,
  workload: Workload,
  supabaseHome: string,
  profilePath: string,
): Record<string, string> => ({
  SUPABASE_HOME: supabaseHome,
  DO_NOT_TRACK: "1",
  SUPABASE_TELEMETRY_DISABLED: "1",
  SUPABASE_NO_KEYRING: "1",
  ...(options.updateCheck ? {} : { SUPABASE_NO_UPDATE_NOTIFIER: "1" }),
  ...(workload.stack === true ? { [STACK_FLAG]: "1" } : {}),
  ...(options.apiUrl === undefined
    ? {}
    : { SUPABASE_PROFILE: profilePath, SUPABASE_ACCESS_TOKEN: BENCH_ACCESS_TOKEN }),
});

/** Longest an untimed setup, teardown, or artifact step may run. */
export const STEP_TIMEOUT = Duration.minutes(5);

export interface Unit {
  readonly projectDir: string;
  readonly env: Record<string, string>;
}

/**
 * A project directory and `SUPABASE_HOME` shared by one unit's setup, launches and teardown, with
 * the replay profile written, the workload's `cwdSetup` applied, its fixture copied in, and the
 * shared artifact cache linked into the home.
 */
const prepareUnit = (options: BenchOptions, workload: Workload, binary: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-bench-cwd-" });
    const supabaseHome = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-bench-home-" });
    const profilePath = path.join(supabaseHome, PROFILE_FILE);
    if (options.apiUrl !== undefined) {
      yield* fs.writeFileString(profilePath, profileYaml(options.apiUrl));
    }
    if (options.artifactCache !== undefined) {
      yield* fs.makeDirectory(options.artifactCache, { recursive: true });
      yield* fs.makeDirectory(path.join(supabaseHome, "cache"), { recursive: true });
      yield* fs.symlink(options.artifactCache, path.join(supabaseHome, "cache", "stack"));
    }
    const env = baseLaunchEnv(options, workload, supabaseHome, profilePath);
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
    if (workload.fixture !== undefined && options.workloadsFile !== undefined) {
      // The fixtures sit outside any `supabase/` directory, which the repository ignores.
      const target = path.join(projectDir, "supabase");
      yield* fs.makeDirectory(target, { recursive: true });
      yield* fs.copy(
        path.join(path.dirname(options.workloadsFile), "fixtures", workload.fixture),
        target,
        { overwrite: true },
      );
    }
    return { projectDir, env } satisfies Unit;
  });

const runStep = Effect.fn("BenchCli.runStep")(function* (
  kind: "setup" | "teardown",
  binary: string,
  unit: Unit,
  args: ReadonlyArray<string>,
) {
  const result = yield* runLaunch({
    binary,
    args,
    cwd: unit.projectDir,
    env: isolatedEnv(process.env, unit.env),
    timeout: STEP_TIMEOUT,
  });
  yield* Effect.annotateCurrentSpan({ "bench.step": kind, "bench.exit_code": result.exitCode });
  if (result.exitCode !== 0) {
    yield* Console.error(
      `warning: ${kind} step "${args.join(" ")}" exited ${result.exitCode}; the workload may not reflect a real stack`,
    );
  }
});

/** Pulls images or downloads archives for each stack runtime, so no measured launch downloads anything. */
export const prepareArtifacts = Effect.fn("BenchCli.prepareArtifacts")(function* (
  options: BenchOptions,
  workloads: ReadonlyArray<Workload>,
) {
  const runtimes = [
    ...new Set(
      workloads.flatMap((workload) =>
        workload.stack === true && workload.runtime !== undefined ? [workload.runtime] : [],
      ),
    ),
  ].sort();
  const scratch: Workload = { id: "install", args: [], cwdSetup: "init", stack: true };
  for (const binary of [options.base, options.branch]) {
    for (const runtime of runtimes) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const unit = yield* prepareUnit(options, scratch, binary);
          yield* runStep("setup", binary, unit, ["stack", "install", "--runtime", runtime]);
        }),
      );
    }
  }
});

type LaunchKind = "warmup" | "timed" | "traced";

interface LaunchOutcome {
  readonly kind: LaunchKind;
  readonly wallMs: number;
  readonly exitCode: number;
  readonly trace: RunSample["trace"];
}

/** Planned units of work for one build: a run-scoped unit holds one launch, a block-scoped one many. */
export interface PlannedUnit {
  readonly build: Build;
  readonly launches: ReadonlyArray<"warmup" | "timed">;
}

/** Measured launches per block for `block`-scoped workloads. */
export const BLOCK_SIZE = 5;

/**
 * Units in execution order. `run` scope reuses {@link buildRunPlan}, one launch per unit.
 * `block` scope starts one unit per block of up to `blockSize` measured launches, preceded by
 * `warmup` discarded launches, and alternates which build goes first in every other block.
 */
export function buildUnitPlan(
  runs: number,
  warmup: number,
  scope: "run" | "block",
  blockSize: number = BLOCK_SIZE,
): ReadonlyArray<PlannedUnit> {
  if (scope === "run") {
    return buildRunPlan(runs, warmup).map((planned) => ({
      build: planned.build,
      launches: [planned.warmup ? "warmup" : "timed"],
    }));
  }
  const units: Array<PlannedUnit> = [];
  const blocks = Math.ceil(runs / blockSize);
  for (let block = 0; block < blocks; block++) {
    const measured = Math.min(blockSize, runs - block * blockSize);
    const launches = [
      ...Array.from({ length: warmup }, () => "warmup" as const),
      ...Array.from({ length: measured }, () => "timed" as const),
    ];
    const order: ReadonlyArray<Build> = block % 2 === 0 ? ["base", "branch"] : ["branch", "base"];
    for (const build of order) units.push({ build, launches });
  }
  return units;
}

/**
 * Runs one unit: setup, the launches in order, then teardown. Teardown is a finalizer registered
 * before setup, so it runs after a failed step or a timed-out launch too.
 */
const runUnit = Effect.fn("BenchCli.runUnit")(function* (params: {
  readonly options: BenchOptions;
  readonly workload: Workload;
  readonly build: Build;
  readonly launches: ReadonlyArray<LaunchKind>;
  readonly profiled: Ref.Ref<boolean>;
  readonly onProfile: (path: string) => void;
}) {
  const { options, workload, build, launches } = params;
  const binary = build === "base" ? options.base : options.branch;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const unit = yield* prepareUnit(options, workload, binary);
      yield* Effect.addFinalizer(() =>
        Effect.forEach(workload.teardown ?? [], (args) => runStep("teardown", binary, unit, args), {
          discard: true,
        }).pipe(Effect.ignore),
      );
      yield* Effect.forEach(workload.setup ?? [], (args) => runStep("setup", binary, unit, args), {
        discard: true,
      });

      // Resets the replay server before each launch, so setup's own requests and a previous
      // launch's consumed scenario never reach the launch that follows.
      const resetServer =
        options.apiUrl === undefined ? Effect.void : resetReplay(options.apiUrl, workload.scenario);
      const timeout = Duration.seconds(workload.timeoutSeconds ?? LAUNCH_TIMEOUT_SECONDS);
      const outcomes: Array<LaunchOutcome> = [];

      for (const kind of launches) {
        yield* resetServer;
        if (kind !== "traced") {
          const result = yield* runLaunch({
            binary,
            args: workload.args,
            cwd: unit.projectDir,
            env: isolatedEnv(process.env, unit.env),
            timeout,
          });
          outcomes.push({ kind, ...result, trace: undefined });
          continue;
        }

        // Tracing and profiling slow the launch they observe, so they run in extra, untimed launches.
        const traceFile = options.trace
          ? yield* fs.makeTempFileScoped({ prefix: "supabase-bench-trace-", suffix: ".jsonl" })
          : undefined;
        let bunOptions: string | undefined;
        if (options.cpuProf && build === "branch") {
          const alreadyProfiled = yield* Ref.getAndSet(params.profiled, true);
          if (!alreadyProfiled) {
            const profileDir = tmpdir();
            const profileName = `supabase-bench-branch-${randomUUID()}.cpuprofile`;
            params.onProfile(path.join(profileDir, profileName));
            bunOptions = `--cpu-prof --cpu-prof-dir=${profileDir} --cpu-prof-name=${profileName}`;
          }
        }
        const traced = yield* runLaunch({
          binary,
          args: workload.args,
          cwd: unit.projectDir,
          env: isolatedEnv(process.env, {
            ...unit.env,
            ...(traceFile === undefined ? {} : { SUPABASE_TRACE_FILE: traceFile }),
            ...(bunOptions === undefined ? {} : { BUN_OPTIONS: bunOptions }),
          }),
          timeout,
        });
        let trace: RunSample["trace"];
        if (traceFile !== undefined) {
          const requestLogCount =
            options.apiUrl === undefined ? undefined : yield* readRequestLogCount(options.apiUrl);
          // Trace data is optional; a missing or unreadable file must not discard timings.
          const decoded = yield* readSpans(traceFile).pipe(Effect.option);
          if (Option.isSome(decoded) && decoded.value.spans.length > 0) {
            const { spans, skippedLines } = decoded.value;
            const http =
              options.apiUrl === undefined ? undefined : classifyHttpSpans(spans, options.apiUrl);
            trace = {
              skippedLines,
              spans: summarizeSpanRun(spans),
              ...(http === undefined || requestLogCount === undefined
                ? {}
                : { api: { ...http, requestLogCount } }),
            };
          }
        }
        outcomes.push({ kind, ...traced, trace });
      }
      return outcomes;
    }),
  );
});

/** Traced launches still wanted for `build`, given how many it has had. */
const wantsTrace = (options: BenchOptions, tracedSoFar: number, traceRuns: number) =>
  options.trace && tracedSoFar < traceRuns;

export const runWorkloadBench = (
  options: BenchOptions,
  workload: Workload,
  profiled: Ref.Ref<boolean>,
) =>
  Effect.gen(function* () {
    const runs = options.runsExplicit ? options.runs : (workload.runs ?? options.runs);
    const warmup = options.warmupExplicit ? options.warmup : (workload.warmup ?? options.warmup);
    const traceRuns = options.trace ? Math.min(workload.traceRuns ?? runs, runs) : 0;
    const scope = workload.setupScope ?? "run";
    const plan = buildUnitPlan(runs, warmup, scope);
    const started = yield* Clock.currentTimeNanos;

    const timed: Record<Build, Array<{ wallMs: number; exitCode: number }>> = {
      base: [],
      branch: [],
    };
    const traced: Record<Build, Array<{ exitCode: number; trace: RunSample["trace"] }>> = {
      base: [],
      branch: [],
    };
    let cpuProfilePath: string | undefined;
    const onProfile = (path: string) => {
      cpuProfilePath = path;
    };

    // A launch is traced when tracing wants more samples for the build, or a branch launch is
    // still to be profiled; the profile needs no trace file.
    const wantsExtra = (build: Build, tracedSoFar: number) =>
      Effect.map(
        Ref.get(profiled),
        (alreadyProfiled) =>
          wantsTrace(options, tracedSoFar, traceRuns) ||
          (options.cpuProf && build === "branch" && !alreadyProfiled),
      );

    const record = (build: Build, outcomes: ReadonlyArray<LaunchOutcome>) => {
      for (const outcome of outcomes) {
        if (outcome.kind === "timed") {
          timed[build].push({ wallMs: outcome.wallMs, exitCode: outcome.exitCode });
        } else if (outcome.kind === "traced") {
          traced[build].push({ exitCode: outcome.exitCode, trace: outcome.trace });
        }
      }
    };

    for (const planned of plan) {
      const { build } = planned;
      if (scope === "run") {
        const outcomes = yield* runUnit({
          options,
          workload,
          build,
          launches: planned.launches,
          profiled,
          onProfile,
        });
        record(build, outcomes);
        if (planned.launches[0] === "timed" && (yield* wantsExtra(build, traced[build].length))) {
          record(
            build,
            yield* runUnit({
              options,
              workload,
              build,
              launches: ["traced"],
              profiled,
              onProfile,
            }),
          );
        }
        continue;
      }
      const measured = planned.launches.filter((kind) => kind === "timed").length;
      const extra: Array<"traced"> = [];
      let tracedCount = traced[build].length;
      for (let index = 0; index < measured; index++) {
        if (!(yield* wantsExtra(build, tracedCount))) break;
        extra.push("traced");
        // A profile-only launch is wanted once, not per measured launch.
        if (!wantsTrace(options, tracedCount, traceRuns)) break;
        tracedCount++;
      }
      record(
        build,
        yield* runUnit({
          options,
          workload,
          build,
          launches: [...planned.launches, ...extra],
          profiled,
          onProfile,
        }),
      );
    }

    const sample = (build: Build): Array<RunSample> =>
      timed[build].map((launch, index) => {
        const extra = traced[build][index];
        return {
          ...launch,
          ...(extra === undefined ? {} : { tracedExitCode: extra.exitCode }),
          ...(extra?.trace === undefined ? {} : { trace: extra.trace }),
        };
      });
    const finished = yield* Clock.currentTimeNanos;
    const report: WorkloadReport = {
      id: workload.id,
      args: workload.args,
      ...(workload.runtime === undefined ? {} : { runtime: workload.runtime }),
      ...(workload.stack === undefined ? {} : { stack: workload.stack }),
      ...(options.trace ? { traceRuns } : {}),
      elapsedSeconds: Math.round(Number(finished - started) / 1_000_000) / 1000,
      base: sample("base"),
      branch: sample("branch"),
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
  yield* prepareArtifacts(options, workloads);
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
