/**
 * Renders a `bench-cli.ts --out` report as Markdown: the answer first, then a timing table, API
 * calls, container operations (integration-heavy section), binary size, and collapsed details. Run
 * as `bun scripts/bench-summary.ts --report <file>` with optional `--section
 * lightweight|integration-heavy`, `--branch-build|--base-build|--replay ok|failed` step outcomes,
 * `--head-sha`, `--base-ref`, `--merge-base`, and `--comment-out <file>` for the pull request
 * comment variant; the job summary goes to `GITHUB_STEP_SUMMARY` when set, otherwise to stdout.
 */
import process from "node:process";
import { parseArgs } from "node:util";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Effect, FileSystem, Option, Stdio } from "effect";
import {
  analyzeWorkload,
  collectFlags,
  decodeBenchReport,
  VERDICT_MIN_PCT,
  totalContainerCalls,
  type BenchReport,
  type Flag,
  type WorkloadAnalysis,
} from "./bench-report.ts";

const USAGE =
  "usage: bun scripts/bench-summary.ts --report <file> [--section lightweight|integration-heavy] [--note <text>] [--branch-build ok|failed] [--base-build ok|failed] [--replay ok|failed] [--head-sha <sha>] [--base-ref <ref>] [--merge-base <sha>] [--comment-out <file>]";

type Outcome = "ok" | "failed";

/** The benchmark a report covers; each has its own pull request comment. */
export type Section = "lightweight" | "integration-heavy";

export const SECTION_NAMES: Record<Section, string> = {
  lightweight: "Lightweight Commands",
  "integration-heavy": "Integration Heavy Commands",
};

export interface SummaryOptions {
  readonly report: string | undefined;
  readonly section: Section;
  readonly note: string | undefined;
  readonly branchBuild: Outcome;
  readonly baseBuild: Outcome;
  readonly replay: Outcome;
  readonly headSha: string | undefined;
  readonly baseRef: string | undefined;
  readonly mergeBase: string | undefined;
  readonly commentOut: string | undefined;
}

const OUTCOME_FLAGS = ["branch-build", "base-build", "replay"] as const;

/** Parses argv; throws on an unknown outcome or a missing report when every step succeeded. */
export function parseSummaryArgs(argv: ReadonlyArray<string>): SummaryOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      report: { type: "string" },
      section: { type: "string", default: "lightweight" },
      note: { type: "string" },
      "branch-build": { type: "string", default: "ok" },
      "base-build": { type: "string", default: "ok" },
      replay: { type: "string", default: "ok" },
      "head-sha": { type: "string" },
      "base-ref": { type: "string" },
      "merge-base": { type: "string" },
      "comment-out": { type: "string" },
    },
  });
  for (const flag of OUTCOME_FLAGS) {
    if (values[flag] !== "ok" && values[flag] !== "failed") {
      throw new Error(`--${flag} must be "ok" or "failed"`);
    }
  }
  if (values.section !== "lightweight" && values.section !== "integration-heavy") {
    throw new Error('--section must be "lightweight" or "integration-heavy"');
  }
  const options: SummaryOptions = {
    report: values.report,
    section: values.section,
    note: values.note,
    branchBuild: values["branch-build"] === "failed" ? "failed" : "ok",
    baseBuild: values["base-build"] === "failed" ? "failed" : "ok",
    replay: values.replay === "failed" ? "failed" : "ok",
    headSha: values["head-sha"],
    baseRef: values["base-ref"],
    mergeBase: values["merge-base"],
    commentOut: values["comment-out"],
  };
  if (values.report === undefined && summaryNotice(options) === undefined) throw new Error(USAGE);
  return options;
}

const NO_REPORT =
  "The benchmark did not produce a report. See the Run benchmark step in the workflow run.";
const UNREADABLE_REPORT =
  "The benchmark report could not be read. See the Write job summary step in the workflow run.";

/** The reason there is nothing to compare, in the order the steps run, or undefined when all ran. */
export function summaryNotice(
  options: Pick<SummaryOptions, "branchBuild" | "baseBuild" | "replay">,
): string | undefined {
  if (options.branchBuild === "failed") {
    return "The build of this commit failed, so there is nothing to compare.";
  }
  if (options.baseBuild === "failed") {
    return "The build of the base branch failed, so there is nothing to compare.";
  }
  if (options.replay === "failed") {
    return "The local test server failed to start, so the benchmark did not run. See the Start replay server step in the workflow run.";
  }
  return undefined;
}

const sign = (value: number) => (value >= 0 ? "+" : "");
const ms = (value: number) => `${Math.round(value)} ms`;
const range = (build: WorkloadAnalysis["base"]) =>
  `${Math.round(build.timing.min)}-${Math.round(build.timing.max)} ms`;
const signedMs = (value: number) => `${sign(value)}${Math.round(value)} ms`;
const signedPct = (value: number) => `${sign(value)}${Math.round(value)}%`;

const cell = (value: string) => value.replaceAll("|", "\\|");
/** Inline code for text that comes from the benchmarked build or its workload file. */
const code = (value: string) => `\`${value.replaceAll("`", "'").replaceAll(/\s+/gu, " ")}\``;
const command = (analysis: Pick<WorkloadAnalysis, "args">) =>
  code(["supabase", ...analysis.args].join(" "));
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
const callCount = (count: number | undefined) =>
  `${count ?? "some"} ${count === 1 ? "call" : "calls"}`;
const MIB = 1024 * 1024;
const mb = (bytes: number) => `${(bytes / MIB).toFixed(1)} MB`;

function table(header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

const when = (build: Flag["build"]) => (build === "base" ? "before" : "after");

/** One plain-words sentence for a flag. */
function describeFlag(flag: Flag, analysis: WorkloadAnalysis): string {
  const name = command(analysis);
  const at = when(flag.build);
  switch (flag.kind) {
    case "new-api-calls": {
      const added = analysis.endpointChanges
        .filter((change) => change.branch > change.base)
        .slice(0, 3)
        .map((change) => code(change.endpoint));
      return (
        `${name} now calls the Management API. It made no calls before and now makes ` +
        `${analysis.branch.api?.medianCalls ?? "some"}${added.length === 0 ? "" : ` (${added.join(", ")})`}.`
      );
    }
    case "api-calls-dropped":
      return `${name} no longer calls the Management API. It made ${callCount(analysis.base.api?.medianCalls)} before and now makes none.`;
    case "new-container-calls":
      return `${name} now runs container commands. It ran none before and now runs ${totalContainerCalls(analysis.branch) ?? "some"}.`;
    case "container-calls-dropped":
      return `${name} no longer runs container commands. It ran ${totalContainerCalls(analysis.base) ?? "some"} before and now runs none.`;
    case "container-calls-changed":
      return `${name} runs a different number of container commands: ${totalContainerCalls(analysis.base) ?? "some"} before, ${totalContainerCalls(analysis.branch) ?? "some"} now.`;
    case "external-calls":
      return `${name} made calls to hosts other than the local test server ${at}, so its timing may be skewed.`;
    case "non-deterministic":
      return `${name} makes a different number of API calls from run to run ${at}, so its results are less reliable.`;
    case "request-log-mismatch":
      return `The API calls counted for ${name} ${at} do not match what the local test server saw, so the counts may be wrong.`;
    case "error-status":
      return `${name} got error responses from the local test server ${at}, so it did not follow the recorded scenario.`;
    case "trace-incomplete":
      return `Some runs of ${name} ${at} produced no usable trace, so call counts and phase timings may be incomplete.`;
    case "non-zero-exit":
      return `${name} exited with an error ${at}; its timing is not compared.`;
    case "exit-codes-differ":
      return `${name} exits with different codes before and after, so its timing is not compared.`;
    case "traced-exit-differs":
      return `${name} exited differently when traced ${at}, so its timing is not compared.`;
    case "insufficient-samples":
      return `${name} had too few timed runs for a timing verdict.`;
  }
}

function changeText(analysis: WorkloadAnalysis): string {
  switch (analysis.verdict) {
    case "not comparable":
      return "not compared";
    case "slower":
    case "faster": {
      const delta = Math.abs(Math.round(analysis.deltaMs));
      return `${analysis.verdict} by ${delta} ms (${signedPct(analysis.deltaPct)})`;
    }
    case "within noise":
      return Math.abs(analysis.deltaPct) >= VERDICT_MIN_PCT
        ? `no real change (${signedPct(analysis.deltaPct)}, within normal variation)`
        : "no real change";
  }
}

/** How the workload runs: its container runtime, and `stack` when it uses the stack backend. */
function runtimeLabel(analysis: WorkloadAnalysis): string {
  const runtime = analysis.runtime ?? "docker";
  return analysis.stack ? `stack, ${runtime}` : runtime;
}

const hasRuntimes = (analyses: ReadonlyArray<WorkloadAnalysis>) =>
  analyses.some((analysis) => analysis.runtime !== undefined || analysis.stack);

function timingTable(analyses: ReadonlyArray<WorkloadAnalysis>): string {
  const withRuntime = hasRuntimes(analyses);
  return table(
    ["Command", ...(withRuntime ? ["Runtime"] : []), "Before", "After", "Change"],
    analyses.map((analysis) => [
      command(analysis),
      ...(withRuntime ? [runtimeLabel(analysis)] : []),
      ms(analysis.base.timing.median),
      ms(analysis.branch.timing.median),
      changeText(analysis),
    ]),
  );
}

/** Commands whose container verbs are traced, with the change in each. */
function containerOverview(analyses: ReadonlyArray<WorkloadAnalysis>): {
  readonly line: string;
} {
  const measured = analyses.filter(
    (analysis) =>
      totalContainerCalls(analysis.base) !== undefined &&
      totalContainerCalls(analysis.branch) !== undefined,
  );
  if (measured.length === 0) return { line: "Container operations were not counted." };
  const changed = measured.filter((analysis) => analysis.containerChanges.length > 0);
  if (changed.length === 0) {
    const any = measured.some(
      (analysis) =>
        (totalContainerCalls(analysis.base) ?? 0) > 0 ||
        (totalContainerCalls(analysis.branch) ?? 0) > 0,
    );
    return {
      line: any
        ? `Container operations: unchanged for ${measured.length === 1 ? "the command" : `all ${measured.length} commands`}.`
        : "Container operations: none recorded.",
    };
  }
  const lines = changed.map((analysis) => {
    const verbs = analysis.containerChanges
      .map((change) => `${code(change.verb)} ${change.base} -> ${change.branch}`)
      .join(", ");
    return `- ${command(analysis)} (${runtimeLabel(analysis)}): ${verbs}`;
  });
  return {
    line: [
      `Container operations changed for ${changed.length} ${plural(changed.length, "command", "commands")}:`,
      ...lines,
    ].join("\n"),
  };
}

function containerDetailTable(analyses: ReadonlyArray<WorkloadAnalysis>): string {
  const rows = analyses.flatMap((analysis) => {
    const { base, branch } = analysis;
    if (base.containers === undefined || branch.containers === undefined) return [];
    const verbs = new Set([...Object.keys(base.containers), ...Object.keys(branch.containers)]);
    return [...verbs]
      .sort()
      .map((verb) => [
        command(analysis),
        runtimeLabel(analysis),
        code(verb),
        String(base.containers?.[verb] ?? 0),
        String(branch.containers?.[verb] ?? 0),
      ]);
  });
  if (rows.length === 0) return "No container operations were recorded.";
  return table(["Command", "Runtime", "Operation", "Before", "After"], rows);
}

interface ApiOverview {
  readonly line: string;
  /** Ids of the commands whose API calls changed. */
  readonly changedIds: ReadonlyArray<string>;
}

function apiOverview(analyses: ReadonlyArray<WorkloadAnalysis>): ApiOverview {
  const measured = analyses.filter(
    (analysis) => analysis.base.api !== undefined && analysis.branch.api !== undefined,
  );
  if (measured.length === 0) return { line: "API calls were not counted.", changedIds: [] };
  const changed = measured.filter(
    (analysis) =>
      analysis.base.api?.medianCalls !== analysis.branch.api?.medianCalls ||
      analysis.endpointChanges.length > 0,
  );
  const missing = analyses.length - measured.length;
  const suffix = missing === 0 ? "" : ` (not measured for ${missing})`;
  if (changed.length === 0) {
    return {
      line: `API calls: unchanged for ${measured.length === 1 ? "the command" : `all ${measured.length} commands`}${suffix}.`,
      changedIds: [],
    };
  }
  const lines = changed.map((analysis) => {
    const endpoints = analysis.endpointChanges
      .map((change) => `${code(change.endpoint)} ${change.base} -> ${change.branch}`)
      .join(", ");
    return `- ${command(analysis)}: ${callCount(analysis.base.api?.medianCalls)} before, ${analysis.branch.api?.medianCalls} now${endpoints === "" ? "" : ` (${endpoints})`}`;
  });
  return {
    line: [
      `API calls changed for ${changed.length} ${plural(changed.length, "command", "commands")}${suffix}:`,
      ...lines,
    ].join("\n"),
    changedIds: changed.map((analysis) => analysis.id),
  };
}

function sizeLine(report: BenchReport): string {
  const { baseSizeBytes: base, branchSizeBytes: branch } = report;
  if (base === undefined || branch === undefined) return "Binary size: not recorded.";
  const delta = branch - base;
  if (delta === 0) return `Binary size: ${mb(branch)}, unchanged.`;
  const abs = Math.abs(delta);
  const size = abs < 1024 ? `${abs} bytes` : abs < MIB ? `${(abs / 1024).toFixed(1)} KB` : mb(abs);
  return `Binary size: ${mb(branch)}, ${delta > 0 ? "up" : "down"} ${size} from ${mb(base)}.`;
}

function apiDetailTable(analyses: ReadonlyArray<WorkloadAnalysis>): string {
  const rows = analyses
    .filter((analysis) => analysis.base.api !== undefined || analysis.branch.api !== undefined)
    .map((analysis) => [
      command(analysis),
      String(analysis.base.api?.medianCalls ?? "n/a"),
      String(analysis.branch.api?.medianCalls ?? "n/a"),
      analysis.endpointChanges
        .map((change) => `${code(change.endpoint)} ${change.base} -> ${change.branch}`)
        .join("<br>"),
    ]);
  if (rows.length === 0) return "API calls were not counted.";
  return table(["Command", "Before", "After", "Endpoint changes"], rows);
}

function rangeTable(analyses: ReadonlyArray<WorkloadAnalysis>): string {
  return table(
    ["Command", "Before range", "After range", "Change", "Verdict"],
    analyses.map((analysis) => [
      command(analysis),
      range(analysis.base),
      range(analysis.branch),
      `${signedMs(analysis.deltaMs)} (${signedPct(analysis.deltaPct)})`,
      analysis.verdict,
    ]),
  );
}

function phaseDetail(analyses: ReadonlyArray<WorkloadAnalysis>): string {
  const rows = analyses.flatMap((analysis) =>
    analysis.phaseRows.map((row) => {
      const only = row.onlyIn === undefined ? undefined : row[row.onlyIn];
      return [
        command(analysis),
        code(row.name),
        row.deltaMs === undefined
          ? `${row.onlyIn === "base" ? "before" : "after"} only, ${Math.round(only?.medianMs ?? 0)} ms`
          : signedMs(row.deltaMs),
        `${row.base === undefined ? "-" : Math.round(row.base.medianMs)} -> ${row.branch === undefined ? "-" : Math.round(row.branch.medianMs)} ms`,
      ];
    }),
  );
  if (rows.length === 0) {
    return analyses.some((analysis) => analysis.verdict === "not comparable")
      ? "No phase deltas are available; some commands were not comparable."
      : "No command moved beyond noise, so there are no phase deltas.";
  }
  return table(["Command", "Span", "Change", "Before -> after"], rows);
}

export interface RenderContext {
  /** A warning shown above the results, such as shards that did not finish. */
  readonly note?: string | undefined;
  readonly section?: Section;
  readonly headSha?: string | undefined;
  readonly baseRef?: string | undefined;
  readonly mergeBase?: string | undefined;
}

const short = (sha: string) => sha.slice(0, 7);

/** "10 runs each", or the range when per-workload run counts differ. */
function runsText(report: BenchReport): string {
  const counts = report.workloads.flatMap((workload) => [
    workload.base.length,
    workload.branch.length,
  ]);
  const low = counts.length === 0 ? report.runs : Math.min(...counts);
  const high = counts.length === 0 ? report.runs : Math.max(...counts);
  return low === high ? `${low} ${plural(low, "run", "runs")} each` : `${low}-${high} runs each`;
}

function contextLine(report: BenchReport | undefined, context: RenderContext): string {
  const parts: Array<string> = [];
  if (context.headSha !== undefined && context.headSha !== "") {
    const against =
      context.baseRef === undefined || context.baseRef === ""
        ? ""
        : ` against ${code(context.baseRef)}${
            context.mergeBase === undefined || context.mergeBase === ""
              ? ""
              : ` at ${code(short(context.mergeBase))}`
          }`;
    parts.push(`Commit ${code(short(context.headSha))}${against}`);
  }
  if (report !== undefined) parts.push(runsText(report));
  parts.push("report only, never blocks merging");
  return parts.join(" · ");
}

function frame(
  title: string,
  body: ReadonlyArray<string>,
  context: RenderContext,
  report?: BenchReport,
): string {
  const section = context.section ?? "lightweight";
  const heading = `## CLI benchmark (${SECTION_NAMES[section]}): ${title}`;
  const note = context.note === undefined || context.note === "" ? [] : [`⚠️ ${context.note}`];
  return [heading, contextLine(report, context), ...note, ...body].join("\n\n") + "\n";
}

/** The Markdown report, or `notice` in plain words when there is no report to compare. */
export function renderSummary(
  report: BenchReport | undefined,
  notice: string,
  context: RenderContext = {},
): string {
  if (report === undefined) return frame("could not run", [notice], context);
  const analyses = report.workloads.map((workload) => analyzeWorkload(workload, report.trace));
  const flags = analyses.flatMap((analysis) =>
    collectFlags(analysis).map((flag) => ({ flag, analysis })),
  );
  if (analyses.length === 0) return frame("no commands were benchmarked", [], context, report);
  const api = apiOverview(analyses);
  const integration = (context.section ?? "lightweight") === "integration-heavy";
  const containers = integration ? containerOverview(analyses) : undefined;
  const moved = analyses
    .filter((analysis) => analysis.verdict === "slower" || analysis.verdict === "faster")
    .map((analysis) => analysis.id);
  const things = new Set([...flags.map(({ analysis }) => analysis.id), ...moved, ...api.changedIds])
    .size;
  const title =
    things === 0 ? "no changes found" : `${things} ${plural(things, "thing", "things")} to check`;
  return frame(
    title,
    [
      ...flags.map(({ flag, analysis }) => `⚠️ ${describeFlag(flag, analysis)}`),
      timingTable(analyses),
      api.line,
      ...(containers === undefined ? [] : [containers.line]),
      sizeLine(report),
      [
        `<details><summary>Details: timing ranges, API calls per command, ${integration ? "container operations, " : ""}slowest phases</summary>`,
        "#### Timing ranges",
        rangeTable(analyses),
        "#### API calls per command",
        apiDetailTable(analyses),
        ...(integration
          ? ["#### Container operations per command", containerDetailTable(analyses)]
          : []),
        "#### Slowest phases",
        phaseDetail(analyses),
        "</details>",
      ].join("\n\n"),
    ],
    context,
    report,
  );
}

export const loadReport = Effect.fn("BenchSummary.loadReport")(function* (
  fs: FileSystem.FileSystem,
  file: string,
) {
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
    return { report: undefined, notice: NO_REPORT };
  }
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeBenchReport),
    Effect.map((report) => ({ report, notice: NO_REPORT })),
    Effect.catch((cause) =>
      Console.error(`could not read benchmark report ${file}: ${String(cause)}`).pipe(
        Effect.as({
          report: undefined,
          notice: UNREADABLE_REPORT,
        }),
      ),
    ),
  );
});

const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const argv = yield* stdio.args;
  const options = yield* Effect.try({
    try: () => parseSummaryArgs(argv),
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  }).pipe(
    Effect.catch((message) =>
      Console.error(message).pipe(
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

  const fs = yield* FileSystem.FileSystem;
  const outcomeNotice = summaryNotice(options);
  const loaded =
    outcomeNotice === undefined && options.report !== undefined
      ? yield* loadReport(fs, options.report)
      : { report: undefined, notice: outcomeNotice ?? NO_REPORT };
  const context = {
    section: options.section,
    note: options.note,
    headSha: options.headSha,
    baseRef: options.baseRef,
    mergeBase: options.mergeBase,
  };
  const markdown = renderSummary(loaded.report, loaded.notice, context);
  const summaryFile = yield* Config.option(Config.String("GITHUB_STEP_SUMMARY"));
  if (Option.isSome(summaryFile) && summaryFile.value !== "") {
    yield* fs.writeFileString(summaryFile.value, markdown, { flag: "a" });
  } else {
    yield* Console.log(markdown);
  }

  if (options.commentOut !== undefined) {
    yield* fs.writeFileString(options.commentOut, markdown);
  }
});

if (import.meta.main) {
  BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer)));
}
