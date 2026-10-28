/**
 * Renders a `bench-cli.ts --out` report as a Markdown job summary: flags, wall time, API calls,
 * phase deltas, and binary size. Run as
 * `bun scripts/bench-summary.ts --report <file> [--base-build ok|failed]`; writes to
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

const USAGE = "usage: bun scripts/bench-summary.ts --report <file> [--base-build ok|failed]";

export interface SummaryOptions {
  readonly report: string | undefined;
  readonly baseBuild: "ok" | "failed";
}

/** Parses argv; throws on an unknown `--base-build` or a missing report for a successful base. */
export function parseSummaryArgs(argv: ReadonlyArray<string>): SummaryOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: { report: { type: "string" }, "base-build": { type: "string", default: "ok" } },
  });
  const baseBuild = values["base-build"];
  if (baseBuild !== "ok" && baseBuild !== "failed") {
    throw new Error('--base-build must be "ok" or "failed"');
  }
  if (values.report === undefined && baseBuild === "ok") throw new Error(USAGE);
  return { report: values.report, baseBuild };
}

const BASE_FAILED = "base build failed, no comparison";
const NO_REPORT = "the benchmark did not produce a report; see the Run benchmark step log";

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
      ? "No phase deltas: no workload had a timing verdict, and some were not comparable."
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

/** The Markdown summary, or the base-build-failed notice when there is no report to compare. */
export function renderSummary(
  report: BenchReport | undefined,
  notice: string = BASE_FAILED,
): string {
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
  const reportFile = options.baseBuild === "failed" ? undefined : options.report;
  const report =
    reportFile === undefined
      ? undefined
      : yield* fs.readFileString(reportFile).pipe(
          Effect.flatMap(decodeBenchReport),
          Effect.orElseSucceed(() => undefined),
        );
  const markdown = renderSummary(report, reportFile === undefined ? BASE_FAILED : NO_REPORT);

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
