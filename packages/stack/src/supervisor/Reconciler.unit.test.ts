import { describe, expect, it } from "@effect/vitest";
import type { ExecutionPlan, PlannedWorkload } from "../model/ExecutionPlan.ts";
import { StackIdSchema } from "../public/StackId.ts";
import { planDesiredState } from "./DesiredState.ts";
import type { ObservedWorkload } from "../runtime/RuntimeDriver.ts";

const stackId = StackIdSchema.make("a".repeat(64));

const workload = (
  id: string,
  dependencies: ReadonlyArray<string> = [],
  specHash = id,
): PlannedWorkload => ({
  id,
  capability: "database",
  dependencies,
  readiness: { mode: "tcp" },
  restart: { maxAttempts: 2, backoffMs: 0 },
  artifacts: {
    native: { kind: "native", service: id, release: "test" },
    container: { kind: "container", service: id, image: `test/${id}` },
  },
  selected: { kind: "native", service: id, release: "test" },
  specHash,
});

const planFor = (workloads: ReadonlyArray<PlannedWorkload>): ExecutionPlan => ({
  runtime: { kind: "native" },
  activation: {
    database: "eager",
    rest: "eager",
    auth: "eager",
    realtime: "eager",
    storage: "eager",
    functions: "eager",
    studio: "eager",
    mail: "eager",
    analytics: "eager",
    pooler: "eager",
  },
  startOrder: ["database"],
  stopOrder: ["database"],
  dependencies: {
    database: [],
    rest: [],
    auth: [],
    realtime: [],
    storage: [],
    functions: [],
    studio: [],
    mail: [],
    analytics: [],
    pooler: [],
  },
  routes: [],
  workloads,
});

const observed = (
  workloadId: string,
  state: ObservedWorkload["state"],
  desiredGeneration = 1,
  specHash = workloadId,
): ObservedWorkload => ({
  stackId,
  desiredGeneration,
  workloadId,
  specHash,
  state,
});

describe("desired workload planning", () => {
  it("starts in topological order and stops/removes in reverse order", () => {
    const workloads = [workload("a"), workload("b", ["a"]), workload("c", ["b"])];
    const plan = planFor(workloads);
    const running = planDesiredState({
      stackId,
      desiredGeneration: 1,
      desiredLifecycle: "running",
      plan,
      observed: [],
    });
    expect(running.starts.map(({ key }) => key.workloadId)).toEqual(["a", "b", "c"]);

    const stopped = planDesiredState({
      stackId,
      desiredGeneration: 1,
      desiredLifecycle: "stopped",
      plan,
      observed: workloads.map(({ id }) => observed(id, "ready")),
    });
    expect(stopped.stops.map(({ key }) => key.workloadId)).toEqual(["c", "b", "a"]);
    expect(stopped.removes.map(({ key }) => key.workloadId)).toEqual(["c", "b", "a"]);

    const destroying = planDesiredState({
      stackId,
      desiredGeneration: 1,
      desiredLifecycle: "destroying",
      plan,
      observed: workloads.map(({ id }) => observed(id, "ready")),
    });
    expect(destroying.stops.map(({ key }) => key.workloadId)).toEqual(["c", "b", "a"]);
  });

  it("replaces a stale generation or workload spec before starting the accepted key", () => {
    const plan = planFor([workload("a", [], "new-hash")]);
    const delta = planDesiredState({
      stackId,
      desiredGeneration: 2,
      desiredLifecycle: "running",
      plan,
      observed: [observed("a", "ready", 1, "old-hash")],
    });
    expect(delta.stops.map(({ key }) => key)).toEqual([
      { stackId, desiredGeneration: 1, workloadId: "a", specHash: "old-hash" },
    ]);
    expect(delta.removes.map(({ key }) => key)).toEqual([
      { stackId, desiredGeneration: 1, workloadId: "a", specHash: "old-hash" },
    ]);
    expect(delta.starts.map(({ key }) => key)).toEqual([
      { stackId, desiredGeneration: 2, workloadId: "a", specHash: "new-hash" },
    ]);
  });

  it("cleans every duplicate exact resource child-first", () => {
    const plan = planFor([workload("a"), workload("b", ["a"])]);
    const delta = planDesiredState({
      stackId,
      desiredGeneration: 2,
      desiredLifecycle: "running",
      plan,
      observed: [
        observed("a", "ready", 1, "old-a"),
        observed("a", "ready", 2, "a"),
        observed("b", "ready", 1, "old-b"),
        observed("b", "ready", 2, "b"),
      ],
    });
    expect(delta.starts).toHaveLength(0);
    expect(delta.stops.map(({ key }) => key.workloadId)).toEqual(["b", "a"]);
    expect(delta.removes.map(({ key }) => key.workloadId)).toEqual(["b", "a"]);
    expect(delta.removes.map(({ key }) => key.specHash)).toEqual(["old-b", "old-a"]);
  });

  it("blocks only dependents of failed workloads", () => {
    const plan = planFor([
      workload("root-failed"),
      workload("dependent", ["root-failed"]),
      workload("independent"),
    ]);
    const delta = planDesiredState({
      stackId,
      desiredGeneration: 1,
      desiredLifecycle: "running",
      plan,
      observed: [observed("root-failed", "failed")],
    });
    expect(delta.starts.map(({ key }) => key.workloadId)).toEqual([
      "root-failed",
      "dependent",
      "independent",
    ]);
    expect(delta.blocked).toEqual([]);
  });
});
