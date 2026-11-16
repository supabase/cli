import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  analyzeWorkload,
  collectFlags,
  parseWorkloadManifest,
  validateWorkloads,
  type RunSample,
  type WorkloadReport,
} from "./bench-report.ts";

const plain = (wallMs = 100): RunSample => ({ wallMs, exitCode: 0, tracedExitCode: 0 });

const times = (n: number, make: (i: number) => RunSample) =>
  Array.from({ length: n }, (_, i) => make(i));

describe("stack workload rules", () => {
  const stackWorkload = {
    id: "s",
    args: ["stack", "status"],
    cwdSetup: "init",
    stack: true,
    runtime: "native",
    setup: [["stack", "start", "--runtime", "native"]],
    teardown: [["stack", "destroy", "--yes"]],
  } as const;

  it.effect("decodes the setup, scope, runtime, fixture and sizing fields", () =>
    Effect.gen(function* () {
      const [parsed] = yield* parseWorkloadManifest(
        `{"workloads":[{
          "id":"s","args":["stack","status"],"cwdSetup":"init","stack":true,"runtime":"native",
          "setup":[["stack","start","--runtime","native"]],
          "teardown":[["stack","destroy","--yes"]],
          "setupScope":"block","fixture":"migrations","runs":10,"warmup":1,"traceRuns":2,
          "timeoutSeconds":120,"estimatedSeconds":90
        }]}`,
      );

      expect(parsed).toMatchObject({
        setupScope: "block",
        teardown: [["stack", "destroy", "--yes"]],
        runtime: "native",
        fixture: "migrations",
        estimatedSeconds: 90,
      });
    }),
  );

  it("accepts a stack workload whose stack start names its runtime", () => {
    expect(validateWorkloads([stackWorkload], { apiUrl: undefined })).toEqual([]);
  });

  it.each([
    [
      "a stack workload with no runtime",
      { ...stackWorkload, runtime: undefined },
      'workload "s" is a stack workload and needs a runtime',
    ],
    [
      "the native runtime outside stack mode",
      { ...stackWorkload, stack: undefined },
      'workload "s" uses the native runtime, which only stack workloads support',
    ],
    [
      "a stack start without --runtime",
      { ...stackWorkload, setup: [["stack", "start"]] },
      'workload "s" runs stack start without --runtime native',
    ],
    [
      "a stack start on another runtime",
      { ...stackWorkload, args: ["stack", "start", "--runtime", "docker"] },
      'workload "s" runs stack start without --runtime native',
    ],
    [
      "a stack workload with no teardown",
      { ...stackWorkload, teardown: undefined },
      'workload "s" is a stack workload and needs a teardown that destroys its stack',
    ],
    ["a zero run count", { ...stackWorkload, runs: 0 }, 'workload "s" has an invalid runs'],
    [
      "a fractional timeout",
      { ...stackWorkload, timeoutSeconds: 1.5 },
      'workload "s" has an invalid timeoutSeconds',
    ],
    [
      "a non-positive estimate",
      { ...stackWorkload, estimatedSeconds: 0 },
      'workload "s" has an invalid estimatedSeconds',
    ],
  ])("rejects %s", (_name, workload, problem) => {
    expect(validateWorkloads([workload], { apiUrl: undefined })).toEqual([problem]);
  });
});

describe("container operations", () => {
  const containerSample = (counts: Record<string, number>): RunSample => ({
    ...plain(),
    trace: {
      skippedLines: 0,
      spans: Object.fromEntries(
        Object.entries(counts).map(([name, count]) => [name, { totalMs: count * 4, count }]),
      ),
    },
  });
  const containerWorkload = (
    base: Record<string, number>,
    branch: Record<string, number>,
    extra: Partial<WorkloadReport> = {},
  ): WorkloadReport => ({
    id: "w",
    args: ["status"],
    base: times(5, () => containerSample(base)),
    branch: times(5, () => containerSample(branch)),
    ...extra,
  });

  it("sums spawn and run spans per verb and ignores other spans", () => {
    const analysis = analyzeWorkload(
      containerWorkload(
        {
          "ContainerCli.spawn (container inspect)": 2,
          "ContainerCli.run (container inspect)": 1,
          "cli.run": 1,
        },
        { "ContainerCli.spawn (container inspect)": 3 },
      ),
      true,
    );

    expect(analysis.base.containers).toEqual({ "container inspect": 3 });
    expect(analysis.branch.containers).toEqual({ "container inspect": 3 });
    expect(analysis.containerChanges).toEqual([]);
    expect(collectFlags(analysis)).toEqual([]);
  });

  it("flags an extra call as a change", () => {
    const analysis = analyzeWorkload(
      containerWorkload(
        { "ContainerCli.spawn (container inspect)": 3 },
        { "ContainerCli.spawn (container inspect)": 4 },
      ),
      true,
    );

    expect(collectFlags(analysis).map((flag) => flag.kind)).toEqual(["container-calls-changed"]);
    expect(analysis.containerChanges).toEqual([{ verb: "container inspect", base: 3, branch: 4 }]);
  });

  it("flags container calls that appear from zero and ones that drop to zero", () => {
    const appeared = analyzeWorkload(
      containerWorkload({ "cli.run": 1 }, { "ContainerCli.spawn (ps)": 2 }),
      true,
    );
    const dropped = analyzeWorkload(
      containerWorkload({ "ContainerCli.run (ps)": 2 }, { "cli.run": 1 }),
      true,
    );

    expect(collectFlags(appeared).map((flag) => flag.kind)).toEqual(["new-container-calls"]);
    expect(collectFlags(dropped).map((flag) => flag.kind)).toEqual(["container-calls-dropped"]);
  });

  it("does not flag container calls when one build has no usable trace", () => {
    const analysis = analyzeWorkload(
      {
        ...containerWorkload({ "ContainerCli.spawn (ps)": 2 }, {}),
        branch: times(5, () => plain()),
      },
      true,
    );

    expect(collectFlags(analysis).map((flag) => flag.kind)).not.toContain(
      "container-calls-dropped",
    );
  });

  it("leaves container calls uncounted for stack workloads and untraced runs", () => {
    const stack = analyzeWorkload(
      containerWorkload(
        { "ContainerCli.spawn (ps)": 1 },
        { "ContainerCli.spawn (ps)": 2 },
        { stack: true },
      ),
      true,
    );
    const untraced = analyzeWorkload(
      {
        id: "w",
        args: ["status"],
        base: times(5, () => plain()),
        branch: times(5, () => plain()),
      },
      false,
    );

    expect(stack.base.containers).toBeUndefined();
    expect(collectFlags(stack)).toEqual([]);
    expect(untraced.base.containers).toBeUndefined();
  });
});

describe("traced run expectations", () => {
  const tracedSample: RunSample = {
    ...plain(),
    trace: { skippedLines: 0, spans: { "cli.run": { totalMs: 50, count: 1 } } },
  };
  const withTraceRuns = (traceRuns: number): WorkloadReport => ({
    id: "w",
    args: ["start"],
    traceRuns,
    base: [tracedSample, ...times(4, () => plain())],
    branch: [tracedSample, ...times(4, () => plain())],
  });

  it("does not flag runs without a trace beyond the workload's traceRuns", () => {
    expect(collectFlags(analyzeWorkload(withTraceRuns(1), true))).toEqual([]);
  });

  it("flags each build that is missing traces the workload expected", () => {
    expect(collectFlags(analyzeWorkload(withTraceRuns(2), true)).map((flag) => flag.kind)).toEqual([
      "trace-incomplete",
      "trace-incomplete",
    ]);
  });
});
