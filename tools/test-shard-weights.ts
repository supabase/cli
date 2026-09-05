/**
 * Builds `.vitest/shard-weights.json`, the per-file test durations that the
 * root Vitest sequencer uses to balance CI shards (ADR 0024).
 *
 * Usage:
 *   bun tools/test-shard-weights.ts merge --out <weights.json> [--previous <weights.json>] <report.json>...
 *
 * Inputs are Vitest `json` reporter files (`--reporter=json --outputFile=...`),
 * one per shard of the develop run. Each file's duration is its `endTime -
 * startTime` in seconds, keyed by repo-relative path. Reports are merged with
 * the previous weights so files that did not run this time (skipped, or on a
 * shard that failed) keep their last known duration; a report always wins over
 * the previous file for the files it contains.
 *
 * Run by `.github/workflows/develop-tests.yml` on every develop push; the
 * result is saved to the Actions cache and handed to PR shards by `test.yml`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

interface JsonReport {
  readonly testResults: ReadonlyArray<{
    readonly name: string;
    readonly startTime: number;
    readonly endTime: number;
  }>;
}

interface ShardWeights {
  readonly version: 1;
  readonly generatedAt: string;
  readonly weights: Record<string, number>;
}

function parseArgs(argv: ReadonlyArray<string>) {
  const [command, ...rest] = argv;
  if (command !== "merge") {
    throw new Error(`Unknown command ${JSON.stringify(command)}; expected "merge"`);
  }
  let out: string | undefined;
  let previous: string | undefined;
  const reports: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--out") out = rest[++i];
    else if (arg === "--previous") previous = rest[++i];
    else if (arg !== undefined) reports.push(arg);
  }
  if (out === undefined) throw new Error("--out <weights.json> is required");
  return { out, previous, reports };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main(argv: ReadonlyArray<string>): number {
  const { out, previous, reports } = parseArgs(argv);
  const root = process.cwd();
  const weights: Record<string, number> = {};
  if (previous !== undefined) {
    Object.assign(weights, readJson<ShardWeights>(previous).weights);
  }
  let recorded = 0;
  for (const report of reports) {
    for (const result of readJson<JsonReport>(report).testResults) {
      const seconds = (result.endTime - result.startTime) / 1000;
      if (!Number.isFinite(seconds) || seconds < 0) continue;
      weights[relative(root, resolve(result.name))] = Math.round(seconds * 100) / 100;
      recorded++;
    }
  }
  const sorted = Object.fromEntries(Object.entries(weights).sort(([a], [b]) => a.localeCompare(b)));
  const output: ShardWeights = {
    version: 1,
    generatedAt: new Date().toISOString(),
    weights: sorted,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `wrote ${out}: ${Object.keys(sorted).length} files (${recorded} from ${reports.length} report${reports.length === 1 ? "" : "s"})`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
