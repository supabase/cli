import { describe, expect, it } from "vitest";
import { analyzeTrace, type ReportSpan } from "./trace-report.ts";

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
});
