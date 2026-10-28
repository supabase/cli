import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  aggregateSpanRuns,
  analyzeWorkload,
  classifyHttpSpans,
  collectFlags,
  decodeBenchReport,
  encodeBenchReport,
  compareSpans,
  deltaOf,
  exitCodesDiffer,
  parseWorkloadManifest,
  summarizeSpanRun,
  summarizeTimings,
  timingVerdict,
  validateWorkloads,
  type BenchReport,
  type RunSample,
  type SpanRunSummary,
  type WorkloadReport,
} from "./bench-report.ts";
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

const httpSpan = (
  method: string,
  path: string,
  port: number,
  status = 200,
  address = "127.0.0.1",
): ReportSpan => ({
  ...span(method, 0, 5),
  http: { method, path, address, port, status },
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

describe("exitCodesDiffer", () => {
  it("flags builds that exit differently but not shared failures", () => {
    expect(exitCodesDiffer([1, 1], [1, 1])).toBe(false);
    expect(exitCodesDiffer([0, 0], [1, 0])).toBe(true);
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
  it("sums duration and counts per span name within one run, leaving HTTP spans to the API section", () => {
    const run = [
      span("Config.load", 0, 10),
      span("Db.query", 10, 20),
      span("Db.query", 20, 50),
      httpSpan("GET", "/v1/projects", 1),
    ];

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

    expect(aggregateSpanRuns(runs)).toEqual({ "Db.query": { medianMs: 40, medianCount: 2 } });
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

    expect(
      compareSpans(base, branch).map((entry) => [entry.name, entry.deltaMs, entry.onlyIn]),
    ).toEqual([
      ["Config.load", 30, undefined],
      ["Credentials.load", undefined, "base"],
      ["Otlp.flush", undefined, "branch"],
    ]);
  });
});

describe("workload manifest", () => {
  const entry = { id: "w", args: ["init"], cwdSetup: "none" } as const;

  it.effect("decodes entries and rejects an unknown cwdSetup", () =>
    Effect.gen(function* () {
      const parsed = yield* parseWorkloadManifest(
        '{"workloads":[{"id":"w","args":["init"],"cwdSetup":"none"}]}',
      );
      expect(parsed).toEqual([entry]);

      const exit = yield* Effect.exit(
        parseWorkloadManifest('{"workloads":[{"id":"w","args":["init"],"cwdSetup":"bogus"}]}'),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  it("requires --api-url for scenarios and unique ids", () => {
    const problems = validateWorkloads(
      [
        { id: "b", args: [], cwdSetup: "none", scenario: "s" },
        { id: "b", args: [], cwdSetup: "none" },
      ],
      { apiUrl: undefined },
    );

    expect(problems).toEqual([
      'workload "b" names a scenario and needs --api-url',
      'duplicate workload id "b"',
    ]);
    expect(
      validateWorkloads([{ ...entry, scenario: "s" }], { apiUrl: "http://127.0.0.1:1" }),
    ).toEqual([]);
  });
});

describe("classifyHttpSpans", () => {
  const apiUrl = "http://127.0.0.1:4010";

  it("counts calls to the API host and port per endpoint and separates other hosts and ports", () => {
    const summary = classifyHttpSpans(
      [
        httpSpan("GET", "/v1/projects", 4010),
        httpSpan("GET", "/v1/projects", 4010),
        httpSpan("POST", "/v1/x", 4010, 502),
        httpSpan("GET", "/v1/projects", 4011),
        httpSpan("GET", "/", 443, 200, "api.supabase.com"),
        span("Config.load", 0, 1),
      ],
      apiUrl,
    );

    expect(summary).toEqual({
      apiCalls: 3,
      externalCalls: 2,
      errorStatuses: 1,
      endpoints: { "GET /v1/projects": 2, "POST /v1/x": 1 },
    });
  });
});

describe("timingVerdict", () => {
  const base = { median: 100, min: 95, max: 108, p90: 107 };
  const context = { comparable: true, samples: 10 };

  it.each([
    { branch: { median: 120, min: 115, max: 125, p90: 124 }, expected: "slower" },
    { branch: { median: 80, min: 78, max: 90, p90: 88 }, expected: "faster" },
    { branch: { median: 103, min: 99, max: 110, p90: 109 }, expected: "within noise" },
    { branch: { median: 107, min: 99, max: 118, p90: 117 }, expected: "within noise" },
  ])("calls a branch median of $branch.median $expected", ({ branch, expected }) => {
    expect(timingVerdict(base, branch, context)).toBe(expected);
  });

  it("ignores a large percentage change that is under the absolute floor", () => {
    expect(
      timingVerdict(
        { median: 10, min: 9, max: 11, p90: 11 },
        { median: 14, min: 13, max: 15, p90: 15 },
        context,
      ),
    ).toBe("within noise");
  });

  it("declines to compare when runs are not comparable or too few", () => {
    const slow = { median: 200, min: 190, max: 210, p90: 209 };
    expect(timingVerdict(base, slow, { comparable: false, samples: 10 })).toBe("not comparable");
    expect(timingVerdict(base, slow, { comparable: true, samples: 3 })).toBe("not comparable");
  });
});

const sample = (
  wallMs: number,
  api?: {
    calls: number;
    endpoints?: Record<string, number>;
    log?: number;
    external?: number;
    errors?: number;
  },
  exitCode = 0,
): RunSample => ({
  wallMs,
  exitCode,
  trace: {
    exitCode,
    skippedLines: 0,
    spans: { "cli.run": { totalMs: wallMs / 2, count: 1 } },
    ...(api === undefined
      ? {}
      : {
          api: {
            apiCalls: api.calls,
            externalCalls: api.external ?? 0,
            errorStatuses: api.errors ?? 0,
            endpoints: api.endpoints ?? {},
            requestLogCount: api.log ?? api.calls,
          },
        }),
  },
});

const workload = (
  base: ReadonlyArray<RunSample>,
  branch: ReadonlyArray<RunSample>,
): WorkloadReport => ({
  id: "w",
  args: ["migration", "new"],
  base,
  branch,
});

const times = (n: number, make: (i: number) => RunSample) =>
  Array.from({ length: n }, (_, i) => make(i));

describe("analyzeWorkload and collectFlags", () => {
  it("flags a workload whose base makes no API calls and whose branch makes one", () => {
    const analysis = analyzeWorkload(
      workload(
        times(5, () => sample(50, { calls: 0 })),
        times(5, () => sample(51, { calls: 1, endpoints: { "GET /v1/projects/abc": 1 } })),
      ),
      true,
    );

    expect(collectFlags(analysis).map((flag) => flag.kind)).toEqual(["new-api-calls"]);
    expect(analysis.endpointChanges).toEqual([
      { endpoint: "GET /v1/projects/abc", base: 0, branch: 1 },
    ]);
  });

  it("lists a count change from one call to two without a zero flag", () => {
    const analysis = analyzeWorkload(
      workload(
        times(5, () => sample(50, { calls: 1, endpoints: { "GET /v1/projects": 1 } })),
        times(5, () => sample(50, { calls: 2, endpoints: { "GET /v1/projects": 2 } })),
      ),
      true,
    );

    expect(collectFlags(analysis)).toEqual([]);
    expect(analysis.branch.api?.medianCalls).toBe(2);
    expect(analysis.endpointChanges).toEqual([
      { endpoint: "GET /v1/projects", base: 1, branch: 2 },
    ]);
  });

  it("flags external calls, non-determinism, and spans that disagree with the request log", () => {
    const noisy = [
      sample(50, { calls: 1, endpoints: { "GET /a": 1 }, external: 1 }),
      sample(50, { calls: 2, endpoints: { "GET /a": 2 }, log: 1 }),
      sample(50, { calls: 1, endpoints: { "GET /a": 1 } }),
      sample(50, { calls: 1, endpoints: { "GET /a": 1 } }),
      sample(50, { calls: 1, endpoints: { "GET /a": 1 } }),
    ];
    const steady = times(5, () => sample(50, { calls: 1, endpoints: { "GET /a": 1 } }));

    const kinds = collectFlags(analyzeWorkload(workload(steady, noisy), true)).map(
      (flag) => flag.kind,
    );

    expect(kinds).toEqual(["external-calls", "non-deterministic", "request-log-mismatch"]);
  });

  it("flags a branch that lost all API calls and treats a missing trace as incomplete", () => {
    const analysis = analyzeWorkload(
      workload(
        times(5, () => sample(50, { calls: 1 })),
        [...times(4, () => sample(50, { calls: 0 })), { wallMs: 50, exitCode: 0 }],
      ),
      true,
    );

    expect(collectFlags(analysis).map((flag) => flag.kind)).toEqual([
      "api-calls-dropped",
      "trace-incomplete",
    ]);
  });

  it("withholds the verdict and flags failures when a build exits non-zero or gets error responses", () => {
    const failing = times(5, () => sample(200, { calls: 1, errors: 1 }, 1));
    const analysis = analyzeWorkload(
      workload(
        times(5, () => sample(50, { calls: 1 })),
        failing,
      ),
      true,
    );

    expect(analysis.verdict).toBe("not comparable");
    expect(collectFlags(analysis).map((flag) => flag.kind)).toEqual([
      "exit-codes-differ",
      "non-zero-exit",
      "error-status",
    ]);
  });

  it("reports the heaviest phase deltas only when the timing verdict is slower or faster", () => {
    const slow = analyzeWorkload(
      workload(
        times(5, (i) => sample(100 + i)),
        times(5, (i) => sample(200 + i)),
      ),
      true,
    );
    const same = analyzeWorkload(
      workload(
        times(5, (i) => sample(100 + i)),
        times(5, (i) => sample(101 + i)),
      ),
      true,
    );

    expect(slow.verdict).toBe("slower");
    expect(slow.phaseRows.map((row) => row.name)).toEqual(["cli.run"]);
    expect(same.verdict).toBe("within noise");
    expect(same.phaseRows).toEqual([]);
  });
});

describe("classifyHttpSpans host matching", () => {
  it("matches a bracketed IPv6 API URL against the unbracketed span address", () => {
    const summary = classifyHttpSpans(
      [httpSpan("GET", "/v1/x", 4010, 200, "::1")],
      "http://[::1]:4010",
    );

    expect(summary.apiCalls).toBe(1);
    expect(summary.externalCalls).toBe(0);
  });

  it("counts a call to another host as external even when its port is unknown", () => {
    const other: ReportSpan = {
      ...span("GET", 0, 1),
      http: { method: "GET", path: "/", address: "api.example.com", port: undefined, status: 200 },
    };

    expect(classifyHttpSpans([other], "http://127.0.0.1:4010").externalCalls).toBe(1);
  });
});

describe("more flags", () => {
  it("explains a missing verdict when there are too few runs", () => {
    const few = times(3, () => sample(50, { calls: 1 }));

    const flags = collectFlags(analyzeWorkload(workload(few, few), true));

    expect(flags.map((flag) => flag.kind)).toEqual(["insufficient-samples"]);
  });

  it("flags a traced launch that exits differently from the timed launches", () => {
    const traced = sample(50, { calls: 1 });
    const odd: RunSample = { ...traced, trace: { ...traced.trace!, exitCode: 1 } };

    const flags = collectFlags(
      analyzeWorkload(
        workload(
          times(5, () => sample(50, { calls: 1 })),
          times(5, () => odd),
        ),
        true,
      ),
    );

    expect(flags.map((flag) => flag.kind)).toContain("traced-exit-differs");
  });
});

describe("report JSON", () => {
  const minimal: BenchReport = {
    base: "/b",
    branch: "/c",
    runs: 5,
    warmup: 1,
    trace: false,
    workloads: [{ id: "w", args: ["x"], base: [{ wallMs: 1, exitCode: 0 }], branch: [] }],
  };
  const full: BenchReport = {
    ...minimal,
    baseSizeBytes: 10,
    branchSizeBytes: 11,
    trace: true,
    apiUrl: "http://127.0.0.1:1",
    cpuProfilePath: "/p",
    workloads: [
      { ...minimal.workloads[0]!, base: [sample(1, { calls: 1, endpoints: { "GET /a": 1 } })] },
    ],
  };

  it.effect.each([
    { name: "omitted optional fields", report: minimal },
    { name: "every field", report: full },
  ])("round-trips a report with $name", ({ report }) =>
    Effect.gen(function* () {
      const decoded = yield* decodeBenchReport(yield* encodeBenchReport(report));

      expect(decoded).toEqual(report);
    }),
  );
});
