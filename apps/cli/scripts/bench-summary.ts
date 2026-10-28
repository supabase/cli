/**
 * Renders a `bench-cli.ts --out` report as a Markdown job summary: flags, wall time, API calls,
 * phase deltas, and binary size. Run as
 * `bun scripts/bench-summary.ts --report <file> [--branch-build|--base-build|--replay ok|failed]`; writes to
 * `GITHUB_STEP_SUMMARY` when set, otherwise to stdout.
 */
import process from "node:process";
import { parseArgs } from "node:util";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Effect, FileSystem, Option, Stdio } from "effect";
import {
  analyzeWorkload,
  collectFlags,
  decodeBenchReport,
  type BenchReport,
  type Flag,
  type WorkloadAnalysis,
} from "./bench-report.ts";

const USAGE =
  "usage: bun scripts/bench-summary.ts --report <file> [--branch-build ok|failed] [--base-build ok|failed] [--replay ok|failed]";

type Outcome = "ok" | "failed";

export interface SummaryOptions {
  readonly report: string | undefined;
  readonly branchBuild: Outcome;
  readonly baseBuild: Outcome;
  readonly replay: Outcome;
}

const OUTCOME_FLAGS = ["branch-build", "base-build", "replay"] as const;

/** Parses argv; throws on an unknown outcome or a missing report when every step succeeded. */
export function parseSummaryArgs(argv: ReadonlyArray<string>): SummaryOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      report: { type: "string" },
      "branch-build": { type: "string", default: "ok" },
      "base-build": { type: "string", default: "ok" },
      replay: { type: "string", default: "ok" },
    },
  });
  for (const flag of OUTCOME_FLAGS) {
    if (values[flag] !== "ok" && values[flag] !== "failed") {
      throw new Error(`--${flag} must be "ok" or "failed"`);
    }
  }
  const options: SummaryOptions = {
    report: values.report,
    branchBuild: values["branch-build"] === "failed" ? "failed" : "ok",
    baseBuild: values["base-build"] === "failed" ? "failed" : "ok",
    replay: values.replay === "failed" ? "failed" : "ok",
  };
  if (values.report === undefined && summaryNotice(options) === undefined) throw new Error(USAGE);
  return options;
}

const NO_REPORT = "the benchmark did not produce a report; see the Run benchmark step log";

/** The reason there is nothing to compare, in the order the steps run, or undefined when all ran. */
export function summaryNotice(
  options: Pick<SummaryOptions, "branchBuild" | "baseBuild" | "replay">,
): string | undefined {
  if (options.branchBuild === "failed") return "branch build failed, no comparison";
  if (options.baseBuild === "failed") return "base build failed, no comparison";
  if (options.replay === "failed") {
    return "replay server failed to start, no comparison; see the Start replay server step log";
  }
  return undefined;
}

const sign = (value: number) => (value >= 0 ? "+" : "");
const ms = (value: number) => `${value} ms`;
const range = (build: WorkloadAnalysis["base"]) => `${build.timing.min}-${build.timing.max} ms`;

const cell = (value: string) => value.replaceAll("|", "\\|");

function table(header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function flagsSection(flags: ReadonlyArray<Flag>): string {
  if (flags.length === 0) return "No flags.";
  return flags.map((flag) => `- **${flag.workload}** (${flag.kind}): ${flag.detail}`).join("\n");
}

function wallTimeSection(analyses: ReadonlyArray<WorkloadAnalysis>): string {
  return table(
    ["Workload", "Base", "Branch", "Change", "Base range", "Branch range", "Verdict"],
    analyses.map((analysis) => [
      analysis.id,
      ms(analysis.base.timing.median),
      ms(analysis.branch.timing.median),
      `${sign(analysis.deltaMs)}${analysis.deltaMs} ms (${sign(analysis.deltaPct)}${analysis.deltaPct}%)`,
      range(analysis.base),
      range(analysis.branch),
      analysis.verdict,
    ]),
  );
}

function apiSection(analyses: ReadonlyArray<WorkloadAnalysis>): string {
  const rows = analyses
    .filter((analysis) => analysis.base.api !== undefined || analysis.branch.api !== undefined)
    .map((analysis) => [
      analysis.id,
      String(analysis.base.api?.medianCalls ?? "n/a"),
      String(analysis.branch.api?.medianCalls ?? "n/a"),
      analysis.endpointChanges.length === 0
        ? ""
        : analysis.endpointChanges
            .map((change) => `\`${change.endpoint}\` ${change.base} -> ${change.branch}`)
            .join("<br>"),
    ]);
  if (rows.length === 0) return "API calls were not counted.";
  return table(["Workload", "Base", "Branch", "Endpoint changes"], rows);
}

function phaseSection(analyses: ReadonlyArray<WorkloadAnalysis>): string {
  const rows = analyses.flatMap((analysis) =>
    analysis.phaseRows.map((row) => {
      const only = row.onlyIn === undefined ? undefined : row[row.onlyIn];
      return [
        analysis.id,
        row.name,
        row.deltaMs === undefined
          ? `${row.onlyIn} only, ${only?.medianMs} ms`
          : `${sign(row.deltaMs)}${row.deltaMs} ms`,
        `${row.base?.medianMs ?? "-"} -> ${row.branch?.medianMs ?? "-"} ms`,
      ];
    }),
  );
  if (rows.length === 0) {
    return analyses.some((analysis) => analysis.verdict === "not comparable")
      ? "No phase deltas are available; some workloads were not comparable."
      : "No workload moved beyond noise, so there are no phase deltas.";
  }
  return table(["Workload", "Span", "Change", "Base -> branch"], rows);
}

function sizeSection(report: BenchReport): string {
  const { baseSizeBytes: base, branchSizeBytes: branch } = report;
  if (base === undefined || branch === undefined) return "Binary sizes were not recorded.";
  const delta = branch - base;
  return table(
    ["Base", "Branch", "Change"],
    [[`${base} bytes`, `${branch} bytes`, `${sign(delta)}${delta} bytes`]],
  );
}

/** The Markdown summary, or `notice` when there is no report to compare. */
export function renderSummary(report: BenchReport | undefined, notice: string): string {
  const title = "## CLI benchmark (report only)";
  if (report === undefined) return `${title}\n\n${notice}\n`;
  const analyses = report.workloads.map((workload) => analyzeWorkload(workload, report.trace));
  const flags = analyses.flatMap(collectFlags);
  return (
    [
      title,
      `${report.runs} measured runs per build after ${report.warmup} warm-up runs. This job never blocks a pull request.`,
      "### Flags",
      flagsSection(flags),
      "### Wall time",
      wallTimeSection(analyses),
      "### API calls",
      apiSection(analyses),
      "### Phase deltas",
      phaseSection(analyses),
      "### Binary size",
      sizeSection(report),
    ].join("\n\n") + "\n"
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
          notice: "the benchmark report could not be read or decoded; see the job log",
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
  const markdown = renderSummary(loaded.report, loaded.notice);

  const summaryFile = yield* Config.option(Config.String("GITHUB_STEP_SUMMARY"));
  if (Option.isSome(summaryFile) && summaryFile.value !== "") {
    yield* fs.writeFileString(summaryFile.value, markdown, { flag: "a" });
  } else {
    yield* Console.log(markdown);
  }
});

if (import.meta.main) {
  BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer)));
}
