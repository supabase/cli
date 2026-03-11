import { describe, expect, test } from "vitest";
import { ServiceMap, Tracer } from "effect";
import { formatSpanForDebugConsole, makeDebugConsoleExporter } from "./debug-console.ts";

function makeEndedSpan(name: string, attrs: Record<string, unknown> = {}): Tracer.Span {
  const startTime = BigInt(Date.now()) * BigInt(1_000_000);
  const endTime = startTime + BigInt(50_000_000); // 50ms later
  const attributes = new Map(Object.entries(attrs));
  return {
    _tag: "Span",
    name,
    spanId: "abc123",
    traceId: "def456",
    parent: undefined,
    annotations: ServiceMap.empty(),
    links: [],
    sampled: true,
    kind: "internal",
    status: {
      _tag: "Ended",
      startTime,
      endTime,
      exit: { _tag: "Success", value: undefined } as any,
    },
    attributes,
    end: () => {},
    attribute: () => {},
    event: () => {},
    addLinks: () => {},
  };
}

describe("debug-console exporter", () => {
  test("formats and writes ended span info", () => {
    let stderrOutput = "";
    const span = makeEndedSpan("test-span", { command: "login" });
    const exportSpanToDebugConsole = makeDebugConsoleExporter((line) => {
      stderrOutput += line;
    });

    exportSpanToDebugConsole(span);

    expect(stderrOutput).toContain("test-span");
    expect(stderrOutput).toContain("50ms");
    expect(stderrOutput).toContain("login");
    expect(stderrOutput).toContain("\n");
  });

  test("returns undefined for spans that have not ended", () => {
    const span = {
      ...makeEndedSpan("pending-span"),
      status: {
        _tag: "Started",
        startTime: BigInt(Date.now()) * BigInt(1_000_000),
      } as Tracer.SpanStatus,
    };

    expect(formatSpanForDebugConsole(span)).toBeUndefined();
  });
});
