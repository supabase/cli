import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderTrace, shortenTraceId, type TraceRenderInput } from "./traces.render.ts";

const PLAIN = { hasColors: () => false };
const COLOURED = { hasColors: () => true };

beforeEach(() => {
  // Neutralize the ambient environment so the color gate only reacts to the injected stream;
  // see colors.unit.test.ts for the same pattern.
  vi.stubEnv("NO_COLOR", "");
  vi.stubEnv("CLICOLOR", "");
  vi.stubEnv("CLICOLOR_FORCE", "");
  vi.stubEnv("CI", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function trace(spans: TraceRenderInput["spans"]): TraceRenderInput {
  return { traceId: "7f3a9c2b1e4d5678abcdef0123456789", spans };
}

const baseSpan = {
  serviceName: "api",
};

describe("shortenTraceId", () => {
  it("keeps only the first 8 characters of a longer id", () => {
    expect(shortenTraceId("7f3a9c2b1e4d5678")).toBe("7f3a9c2b");
  });

  it("returns a short id unchanged", () => {
    expect(shortenTraceId("abc")).toBe("abc");
  });
});

describe("renderTrace", () => {
  it("prints a summary line with the shortened trace id, duration, span count, errors, and start time", () => {
    const output = renderTrace(
      trace([
        {
          ...baseSpan,
          spanId: "root",
          parentSpanId: undefined,
          name: "app.request",
          startMs: 0,
          endMs: 100,
          isError: false,
        },
      ]),
      { fancy: false },
    );
    expect(output).toContain(
      "Trace 7f3a9c2b — 100ms, 1 span, 0 errors, started 1970-01-01T00:00:00.000Z",
    );
  });

  it("marks the slowest non-root span and lists the first error span in the closing line", () => {
    const output = renderTrace(
      trace([
        {
          ...baseSpan,
          spanId: "root",
          parentSpanId: undefined,
          name: "app.request",
          startMs: 0,
          endMs: 1000,
          isError: false,
        },
        {
          ...baseSpan,
          spanId: "fast",
          parentSpanId: "root",
          name: "fast.step",
          startMs: 0,
          endMs: 10,
          isError: false,
        },
        {
          ...baseSpan,
          spanId: "slow",
          parentSpanId: "root",
          name: "slow.step",
          startMs: 0,
          endMs: 900,
          isError: false,
        },
        {
          ...baseSpan,
          spanId: "broken",
          parentSpanId: "root",
          name: "broken.step",
          startMs: 0,
          endMs: 5,
          isError: true,
        },
      ]),
      { fancy: false },
    );
    expect(output).toContain("slow.step (api) [slowest]");
    expect(output).toContain("broken.step (api) [error]");
    expect(output).toContain("Trace has errors. First error span: broken");
  });

  it("appends the span's service name to its label", () => {
    const output = renderTrace(
      trace([
        {
          ...baseSpan,
          spanId: "root",
          parentSpanId: undefined,
          name: "db.query",
          serviceName: "postgrest",
          startMs: 0,
          endMs: 10,
          isError: false,
        },
      ]),
      { fancy: false },
    );
    expect(output).toContain("db.query (postgrest)");
  });

  it("strips control characters and ANSI escape sequences from a customer-controlled span name", () => {
    const hostile = "evil\u001b[31m;rm -rf\u0007 span";
    const output = renderTrace(
      trace([
        {
          ...baseSpan,
          spanId: "root",
          parentSpanId: undefined,
          name: hostile,
          startMs: 0,
          endMs: 10,
          isError: false,
        },
      ]),
      { fancy: false },
    );
    expect(output).toContain("evil[31m;rm -rf span (api)");
    expect(output.includes("\u001b")).toBe(false);
    expect(output.includes("\u0007")).toBe(false);
  });

  it("indents nested spans with ASCII spacing and no color when fancy is false", () => {
    const output = renderTrace(
      trace([
        {
          ...baseSpan,
          spanId: "root",
          parentSpanId: undefined,
          name: "root.op",
          startMs: 0,
          endMs: 10,
          isError: false,
        },
        {
          ...baseSpan,
          spanId: "child",
          parentSpanId: "root",
          name: "child.op",
          startMs: 1,
          endMs: 5,
          isError: true,
        },
      ]),
      { fancy: false, colorStream: COLOURED },
    );
    expect(output).toContain("  child.op");
    expect(output).not.toContain("\u001b[");
  });

  it("indents nested spans with Unicode tree glyphs and colors an error row when fancy is true", () => {
    const output = renderTrace(
      trace([
        {
          ...baseSpan,
          spanId: "root",
          parentSpanId: undefined,
          name: "root.op",
          startMs: 0,
          endMs: 10,
          isError: false,
        },
        {
          ...baseSpan,
          spanId: "child",
          parentSpanId: "root",
          name: "child.op",
          startMs: 1,
          endMs: 5,
          isError: true,
        },
      ]),
      { fancy: true, colorStream: COLOURED },
    );
    expect(output).toContain("└─ child.op");
    expect(output).toContain("\u001b[");
  });

  it("renders plain text with no color when the stream doesn't support it, even if fancy is true", () => {
    const output = renderTrace(
      trace([
        {
          ...baseSpan,
          spanId: "root",
          parentSpanId: undefined,
          name: "root.op",
          startMs: 0,
          endMs: 10,
          isError: true,
        },
      ]),
      { fancy: true, colorStream: PLAIN },
    );
    expect(output).not.toContain("\u001b[");
  });
});
