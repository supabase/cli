/**
 * Packs benchmark workloads into shards for the stack benchmark matrix. Each shard runs on one
 * runner, so base and branch of a workload always share a machine and no two workloads share one
 * at the same time. Free of runtime dependencies so the workflow's plan job can import it.
 */
import type { Workload } from "./bench-report.ts";

export type PackedWorkload = Pick<Workload, "id" | "runtime" | "estimatedSeconds">;

export interface Shard {
  readonly runtime: "docker" | "native";
  /** 1-based position within the runtime's shards. */
  readonly shard: number;
  /** Shards for this runtime. */
  readonly shards: number;
  readonly workloads: ReadonlyArray<string>;
  readonly estimatedSeconds: number;
}

/** Seconds assumed for a workload that has no estimate. */
export const DEFAULT_ESTIMATE_SECONDS = 60;
/** Seconds of work each shard aims for. */
export const DEFAULT_TARGET_SECONDS = 600;
export const DEFAULT_MAX_SHARDS = 8;

const estimateOf = (workload: PackedWorkload) =>
  workload.estimatedSeconds ?? DEFAULT_ESTIMATE_SECONDS;

/**
 * Splits each runtime's workloads into `ceil(total / target)` shards (at most `maxShards`),
 * assigning the longest workloads first to the lightest shard. Shards come back ordered by runtime
 * then index, with each shard's workloads in manifest order.
 */
export function packShards(
  workloads: ReadonlyArray<PackedWorkload>,
  options: { readonly targetSeconds?: number; readonly maxShards?: number } = {},
): ReadonlyArray<Shard> {
  const target = options.targetSeconds ?? DEFAULT_TARGET_SECONDS;
  const maxShards = options.maxShards ?? DEFAULT_MAX_SHARDS;
  const shards: Array<Shard> = [];
  for (const runtime of ["docker", "native"] as const) {
    const group = workloads.filter((workload) => (workload.runtime ?? "docker") === runtime);
    if (group.length === 0) continue;
    const total = group.reduce((sum, workload) => sum + estimateOf(workload), 0);
    const count = Math.min(maxShards, group.length, Math.max(1, Math.ceil(total / target)));
    const bins = Array.from({ length: count }, () => ({ ids: new Set<string>(), seconds: 0 }));
    const longestFirst = [...group].sort(
      (a, b) => estimateOf(b) - estimateOf(a) || a.id.localeCompare(b.id),
    );
    for (const workload of longestFirst) {
      const lightest = bins.reduce((best, bin) => (bin.seconds < best.seconds ? bin : best));
      lightest.ids.add(workload.id);
      lightest.seconds += estimateOf(workload);
    }
    bins.forEach((bin, index) => {
      shards.push({
        runtime,
        shard: index + 1,
        shards: count,
        workloads: group
          .filter((workload) => bin.ids.has(workload.id))
          .map((workload) => workload.id),
        estimatedSeconds: bin.seconds,
      });
    });
  }
  return shards;
}
