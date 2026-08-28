import type { ExecutionPlan, PlannedWorkload } from "../model/ExecutionPlan.ts";
import type { StackId } from "../public/StackId.ts";
import type { ObservedWorkload, RuntimeWorkloadKey } from "../runtime/RuntimeDriver.ts";

export type DesiredLifecycle = "unconfigured" | "stopped" | "running" | "destroying";

export interface ReconciliationInput {
  readonly stackId: StackId;
  readonly desiredGeneration: number;
  readonly desiredLifecycle: DesiredLifecycle;
  readonly plan: ExecutionPlan;
  readonly observed: ReadonlyArray<ObservedWorkload>;
}

export interface DesiredStart {
  readonly kind: "start";
  readonly key: RuntimeWorkloadKey;
  readonly workload: PlannedWorkload;
}

export interface DesiredStop {
  readonly kind: "stop";
  readonly key: RuntimeWorkloadKey;
}

export interface DesiredRemove {
  readonly kind: "remove";
  readonly key: RuntimeWorkloadKey;
}

export interface BlockedWorkload {
  readonly workloadId: string;
  readonly dependencyId: string;
}

export interface DesiredStatePlan {
  readonly starts: ReadonlyArray<DesiredStart>;
  readonly stops: ReadonlyArray<DesiredStop>;
  readonly removes: ReadonlyArray<DesiredRemove>;
  readonly blocked: ReadonlyArray<BlockedWorkload>;
}

const keyFor = (
  stackId: StackId,
  desiredGeneration: number,
  workloadId: string,
  specHash: string,
): RuntimeWorkloadKey => ({ stackId, desiredGeneration, workloadId, specHash });

const isCurrent = (
  observed: ObservedWorkload | undefined,
  generation: number,
  specHash: string,
): observed is ObservedWorkload =>
  observed !== undefined &&
  observed.desiredGeneration === generation &&
  observed.specHash === specHash;

/**
 * Builds a deterministic desired-state delta. `ExecutionPlan.workloads` is already a stable
 * topological order; reversing it gives the corresponding safe stop/remove order.
 */
export const planDesiredState = (input: ReconciliationInput): DesiredStatePlan => {
  const starts: DesiredStart[] = [];
  const stops: DesiredStop[] = [];
  const removes: DesiredRemove[] = [];
  const blocked: BlockedWorkload[] = [];
  const staleByWorkload = new Map<string, ReadonlyArray<ObservedWorkload>>();
  const observationsFor = (workloadId: string): ReadonlyArray<ObservedWorkload> =>
    input.observed
      .filter((entry) => entry.workloadId === workloadId)
      .sort(
        (left, right) =>
          left.desiredGeneration - right.desiredGeneration ||
          left.specHash.localeCompare(right.specHash),
      );
  const removeEntry = (entry: ObservedWorkload) =>
    removes.push({
      kind: "remove",
      key: keyFor(input.stackId, entry.desiredGeneration, entry.workloadId, entry.specHash),
    });

  if (input.desiredLifecycle === "running") {
    // Failed workloads are restart candidates. Only a failed start in this reconciliation blocks
    // dependents; an observed failure gets one fresh attempt while its generation budget allows.
    const failed = new Set<string>();
    for (const workload of input.plan.workloads) {
      const dependencyFailure = workload.dependencies.find((dependency) => failed.has(dependency));
      if (dependencyFailure !== undefined) {
        blocked.push({ workloadId: workload.id, dependencyId: dependencyFailure });
        failed.add(workload.id);
        continue;
      }
      const observations = observationsFor(workload.id);
      const current = observations.filter((entry) =>
        isCurrent(entry, input.desiredGeneration, workload.specHash),
      );
      // Every duplicate old-generation/spec resource is stale, even when an exact current
      // resource also exists. Never collapse observations by workload id: each exact key must be
      // cleaned independently.
      const stale = observations.filter(
        (entry) =>
          !isCurrent(entry, input.desiredGeneration, workload.specHash) ||
          entry.state === "failed" ||
          entry.state === "stopped",
      );
      if (stale.length > 0) staleByWorkload.set(workload.id, stale);
      if (current.some((entry) => entry.state === "ready" || entry.state === "starting")) continue;
      const key = keyFor(input.stackId, input.desiredGeneration, workload.id, workload.specHash);
      starts.push({ kind: "start", key, workload });
    }
    // Stale replacements are removed child-first, preserving dependency safety when several
    // generations/spec hashes for a planned graph are present at once.
    for (const workload of [...input.plan.workloads].reverse()) {
      for (const entry of staleByWorkload.get(workload.id) ?? []) {
        if (entry.state === "ready" || entry.state === "starting") {
          stops.push({
            kind: "stop",
            key: keyFor(input.stackId, entry.desiredGeneration, entry.workloadId, entry.specHash),
          });
        }
        removeEntry(entry);
      }
    }
  } else {
    const reverse = [...input.plan.workloads].reverse();
    for (const workload of reverse) {
      for (const observed of observationsFor(workload.id)) {
        if (observed.state === "absent") continue;
        const key = keyFor(
          input.stackId,
          observed.desiredGeneration,
          observed.workloadId,
          observed.specHash,
        );
        if (observed.state !== "stopped") {
          stops.push({ kind: "stop", key });
        }
        removeEntry(observed);
      }
    }
  }

  // Resources that no longer appear in the accepted plan are stale by definition. Remove them
  // after the planned reverse-order resources, with a lexical tie-break for deterministic output.
  const known = new Set(input.plan.workloads.map(({ id }) => id));
  const stale = input.observed
    .filter((entry) => !known.has(entry.workloadId) && entry.state !== "absent")
    .sort(
      (left, right) =>
        left.workloadId.localeCompare(right.workloadId) ||
        left.desiredGeneration - right.desiredGeneration ||
        left.specHash.localeCompare(right.specHash),
    );
  for (const entry of stale) {
    if (entry.state === "ready" || entry.state === "starting") {
      stops.push({
        kind: "stop",
        key: keyFor(input.stackId, entry.desiredGeneration, entry.workloadId, entry.specHash),
      });
    }
    removeEntry(entry);
  }

  return { starts, stops, removes, blocked };
};
