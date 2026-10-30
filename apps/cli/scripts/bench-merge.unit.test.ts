import { describe, expect, it } from "vitest";
import type { BenchReport, RunSample } from "./bench-report.ts";
import { mergeReports } from "./bench-merge.ts";

const sample = (calls: number): RunSample => ({
  wallMs: 10,
  exitCode: 0,
  trace: {
    skippedLines: 0,
    spans: {},
    api: {
      apiCalls: calls,
      externalCalls: 2,
      errorStatuses: 0,
      endpoints: {},
      requestLogCount: calls,
    },
  },
});

const shard = (apiUrl: string | undefined, ids: ReadonlyArray<string>, calls = 0): BenchReport => ({
  base: "/base",
  branch: "/branch",
  runs: 1,
  warmup: 0,
  trace: true,
  ...(apiUrl === undefined ? {} : { apiUrl }),
  workloads: ids.map((id) => ({ id, args: [id], base: [sample(calls)], branch: [sample(calls)] })),
});

describe("mergeReports", () => {
  it("keeps each shard's API counts, including a count of zero, in manifest order", () => {
    const merged = mergeReports(
      [shard("http://127.0.0.1:1", ["status"], 0), shard("http://127.0.0.1:2", ["db-query"], 3)],
      ["db-query", "status"],
    );

    expect(merged?.workloads.map((workload) => workload.id)).toEqual(["db-query", "status"]);
    expect(merged?.workloads.map((workload) => workload.branch[0]?.trace?.api?.apiCalls)).toEqual([
      3, 0,
    ]);
  });

  it("carries an API URL even when the first shard recorded none", () => {
    const merged = mergeReports([shard(undefined, ["a"]), shard("http://127.0.0.1:2", ["b"])], []);

    expect(merged?.apiUrl).toBe("http://127.0.0.1:2");
  });
});
