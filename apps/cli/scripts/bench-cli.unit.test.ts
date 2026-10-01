import { describe, expect, it } from "vitest";
import {
  aggregateSpanRuns,
  buildRunPlan,
  compareSpans,
  deltaOf,
  isolatedEnv,
  parseBenchArgs,
  summarizeSpanRun,
  summarizeTimings,
} from "./bench-cli.ts";
import type { SpanRunSummary } from "./bench-cli.ts";
import type { ReportSpan } from "./trace-report.ts";

const span = (name: string, startMs: number, endMs: number): ReportSpan => ({
  traceId: "t",
  spanId: `${name}-${startMs}`,
  parentSpanId: undefined,
  name,
  startMs,
  endMs,
  failed: false,
  errorType: undefined,
});

describe("parseBenchArgs", () => {
  it("accepts commands that start with a dash and keeps update checks off by default", () => {
    const options = parseBenchArgs([
      "--base",
      "/bin/a",
      "--branch",
      "/bin/b",
      "--command",
      "--version",
      "--command",
      "db diff --local",
    ]);

    expect(options.commands).toEqual([["--version"], ["db", "diff", "--local"]]);
    expect(options.updateCheck).toBe(false);
  });
});

describe("summarizeTimings", () => {
  it("computes median, min, max, and p90", () => {
    expect(summarizeTimings([10, 20, 30, 40, 50])).toEqual({
      median: 30,
      min: 10,
      max: 50,
      p90: 50,
    });
  });
});

describe("buildRunPlan", () => {
  it("alternates base and branch and discards the first warmup iterations", () => {
    const plan = buildRunPlan(2, 1);

    expect(plan.map((run) => [run.build, run.warmup])).toEqual([
      ["base", true],
      ["branch", true],
      ["base", false],
      ["branch", false],
      ["base", false],
      ["branch", false],
    ]);
    expect(plan.filter((run) => !run.warmup && run.build === "base")).toHaveLength(2);
    expect(plan.filter((run) => !run.warmup && run.build === "branch")).toHaveLength(2);
  });
});

describe("deltaOf", () => {
  it("reports branch minus base in ms and percent", () => {
    expect(deltaOf(100, 110)).toEqual({ ms: 10, pct: 10 });
  });

  it("reports a zero percent delta instead of Infinity when base is zero", () => {
    expect(deltaOf(0, 5)).toEqual({ ms: 5, pct: 0 });
  });
});

describe("span aggregation", () => {
  it("sums duration and counts per span name within one run", () => {
    const run = [span("Config.load", 0, 10), span("Db.query", 10, 20), span("Db.query", 20, 50)];

    expect(summarizeSpanRun(run)).toEqual({
      "Config.load": { totalMs: 10, count: 1 },
      "Db.query": { totalMs: 40, count: 2 },
    });
  });

  it("medians per-span totals and counts across runs, treating an absent span as zero", () => {
    const runs: ReadonlyArray<Record<string, SpanRunSummary>> = [
      { "Db.query": { totalMs: 40, count: 2 } },
      { "Db.query": { totalMs: 60, count: 2 } },
      {},
    ];

    expect(aggregateSpanRuns(runs)).toEqual({
      "Db.query": { medianMs: 40, medianCount: 2 },
    });
  });
});

describe("compareSpans", () => {
  it("flags spans found in only one build and sorts by absolute delta", () => {
    const base = {
      "Config.load": { medianMs: 10, medianCount: 1 },
      "Credentials.load": { medianMs: 5, medianCount: 1 },
    };
    const branch = {
      "Config.load": { medianMs: 40, medianCount: 1 },
      "Otlp.flush": { medianMs: 3, medianCount: 1 },
    };

    expect(compareSpans(base, branch)).toEqual([
      {
        name: "Config.load",
        base: { medianMs: 10, medianCount: 1 },
        branch: { medianMs: 40, medianCount: 1 },
        deltaMs: 30,
        onlyIn: undefined,
      },
      {
        name: "Credentials.load",
        base: { medianMs: 5, medianCount: 1 },
        branch: undefined,
        deltaMs: undefined,
        onlyIn: "base",
      },
      {
        name: "Otlp.flush",
        base: undefined,
        branch: { medianMs: 3, medianCount: 1 },
        deltaMs: undefined,
        onlyIn: "branch",
      },
    ]);
  });
});

describe("isolatedEnv", () => {
  it("strips SUPABASE_*, OTEL_*, and TRACEPARENT while keeping other ambient variables", () => {
    const ambient = {
      HOME: "/home/person",
      PATH: "/usr/bin",
      SUPABASE_ACCESS_TOKEN: "secret",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
      TRACEPARENT: "00-...-01",
    };

    expect(isolatedEnv(ambient, { SUPABASE_HOME: "/tmp/home", DO_NOT_TRACK: "1" })).toEqual({
      HOME: "/home/person",
      PATH: "/usr/bin",
      SUPABASE_HOME: "/tmp/home",
      DO_NOT_TRACK: "1",
    });
  });
});
