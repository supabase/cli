import { describe, expect, it } from "vitest";
import {
  analyzeTrace,
  parseTraceReportArgs,
  reportSpanName,
  type ReportSpan,
} from "./trace-report.ts";

const span = (
  spanId: string,
  parentSpanId: string | undefined,
  name: string,
  startMs: number,
  endMs: number,
  failed = false,
): ReportSpan => ({
  traceId: "t",
  spanId,
  parentSpanId,
  name,
  startMs,
  endMs,
  failed,
  errorType: failed ? "SqlError" : undefined,
});

describe("analyzeTrace", () => {
  const spans = [
    span("root", undefined, "cli.run", 0, 100),
    span("a", "root", "Config.load", 0, 10),
    span("b", "root", "Db.query", 10, 40),
    span("c", "root", "Db.query", 40, 90, true),
    span("d", "c", "Db.connect", 40, 80),
  ];

  it("follows the longest child from the root", () => {
    expect(analyzeTrace(spans, 5).criticalPath.map((step) => step.name)).toEqual([
      "cli.run",
      "Db.query",
      "Db.connect",
    ]);
  });

  it("subtracts child time from self time", () => {
    const self = Object.fromEntries(
      analyzeTrace(spans, 5).topSelfTime.map((entry) => [entry.name, entry.selfMs]),
    );

    expect(self).toEqual({ "cli.run": 10, "Config.load": 10, "Db.query": 40, "Db.connect": 40 });
  });

  it("reports repeated names and failures", () => {
    const report = analyzeTrace(spans, 5);

    expect(report.repeated).toEqual([{ name: "Db.query", count: 2, totalMs: 80 }]);
    expect(report.failures).toEqual([{ name: "Db.query", errorType: "SqlError" }]);
  });

  it("ignores a child that ends outside its parent when computing self time", () => {
    const report = analyzeTrace(
      [
        span("root", undefined, "cli.run", 0, 100),
        span("late", "root", "Analytics.flush", 150, 200),
        span("inner", "root", "Db.query", 20, 50),
      ],
      5,
    );
    const self = Object.fromEntries(report.topSelfTime.map((entry) => [entry.name, entry.selfMs]));

    expect(self["cli.run"]).toBe(70);
  });
});

describe("parseTraceReportArgs", () => {
  it("reads the trace file, --top, and --json", () => {
    expect(parseTraceReportArgs(["trace.jsonl", "--top", "3", "--json"])).toEqual({
      file: "trace.jsonl",
      top: 3,
      json: true,
    });
  });

  it("defaults --top to 15", () => {
    expect(parseTraceReportArgs(["trace.jsonl"]).top).toBe(15);
  });

  it.each([["0"], ["-2"], ["1.5"], ["abc"]])("rejects --top %s", (value) => {
    expect(() => parseTraceReportArgs(["trace.jsonl", "--top", value])).toThrow(
      "--top must be a positive integer",
    );
  });

  it("rejects --top without a value", () => {
    expect(() => parseTraceReportArgs(["trace.jsonl", "--top"])).toThrow(
      "--top must be a positive integer",
    );
  });

  it("requires a trace file", () => {
    expect(() => parseTraceReportArgs(["--json"])).toThrow("usage:");
  });
});

describe("reportSpanName", () => {
  it("separates container CLI verbs and leaves other spans unchanged", () => {
    expect(reportSpanName("ContainerCli.spawn", "image inspect")).toBe(
      "ContainerCli.spawn (image inspect)",
    );
    expect(reportSpanName("Db.query", undefined)).toBe("Db.query");
  });
});
