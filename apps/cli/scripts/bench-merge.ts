/**
 * Merges the per-shard `bench-cli.ts --out` reports of one run into a single report, ordering
 * workloads as the manifest does. Run as `bun scripts/bench-merge.ts [--workloads <file.json>]
 * --out <file> <shard-report.json>...`. Binary paths, run counts and settings come from the first
 * shard.
 */
import { parseArgs } from "node:util";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Stdio } from "effect";
import {
  decodeBenchReport,
  encodeBenchReport,
  parseWorkloadManifest,
  type BenchReport,
} from "./bench-report.ts";

/** Combines shard reports; a workload that appears in several shards keeps its first report. */
export function mergeReports(
  reports: ReadonlyArray<BenchReport>,
  order: ReadonlyArray<string>,
): BenchReport | undefined {
  const [first] = reports;
  if (first === undefined) return undefined;
  const byId = new Map<string, BenchReport["workloads"][number]>();
  for (const report of reports) {
    for (const workload of report.workloads) {
      if (!byId.has(workload.id)) byId.set(workload.id, workload);
    }
  }
  const rank = (id: string) => {
    const index = order.indexOf(id);
    return index === -1 ? order.length : index;
  };
  const cpuProfilePath = reports.find(
    (report) => report.cpuProfilePath !== undefined,
  )?.cpuProfilePath;
  return {
    ...first,
    workloads: [...byId.values()].sort((a, b) => rank(a.id) - rank(b.id)),
    ...(cpuProfilePath === undefined ? {} : { cpuProfilePath }),
  };
}

const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const argv = yield* stdio.args;
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { workloads: { type: "string" }, out: { type: "string" } },
  });
  if (values.out === undefined || positionals.length === 0) {
    return yield* Effect.fail(
      "usage: bun scripts/bench-merge.ts [--workloads <file.json>] --out <file> <report.json>...",
    );
  }
  const fs = yield* FileSystem.FileSystem;
  const order =
    values.workloads === undefined
      ? []
      : (yield* parseWorkloadManifest(yield* fs.readFileString(values.workloads))).map(
          (workload) => workload.id,
        );
  const reports: Array<BenchReport> = [];
  for (const file of positionals) {
    reports.push(yield* decodeBenchReport(yield* fs.readFileString(file)));
  }
  const merged = mergeReports(reports, order);
  if (merged !== undefined) yield* fs.writeFileString(values.out, yield* encodeBenchReport(merged));
});

if (import.meta.main) {
  BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer)));
}
