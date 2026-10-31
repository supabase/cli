import { describe, expect, it } from "@effect/vitest";
import { packShards } from "./bench-pack.ts";

const workload = (id: string, estimatedSeconds: number, runtime?: "docker" | "native") => ({
  id,
  estimatedSeconds,
  ...(runtime === undefined ? {} : { runtime }),
});

describe("packShards", () => {
  it("balances each runtime's workloads across ceil(total / target) shards and never mixes runtimes", () => {
    const shards = packShards(
      [
        workload("a", 400),
        workload("b", 300),
        workload("c", 300),
        workload("d", 200),
        workload("n1", 100, "native"),
      ],
      { targetSeconds: 600 },
    );

    const docker = shards.filter((shard) => shard.runtime === "docker");
    expect(docker.map((shard) => shard.estimatedSeconds)).toEqual([600, 600]);
    expect(docker.every((shard) => shard.shards === 2)).toBe(true);
    expect(shards.filter((shard) => shard.runtime === "native")).toEqual([
      { runtime: "native", shard: 1, shards: 1, workloads: ["n1"], estimatedSeconds: 100 },
    ]);
  });

  it("puts every workload in exactly one shard and keeps manifest order within a shard", () => {
    const workloads = ["w1", "w2", "w3", "w4", "w5"].map((id, index) =>
      workload(id, 150 + index * 10),
    );

    const shards = packShards(workloads, { targetSeconds: 300 });

    expect(shards.flatMap((shard) => shard.workloads).sort()).toEqual([
      "w1",
      "w2",
      "w3",
      "w4",
      "w5",
    ]);
    for (const shard of shards) {
      expect(shard.workloads).toEqual(
        workloads.map((w) => w.id).filter((id) => shard.workloads.includes(id)),
      );
    }
  });

  it("assumes a default estimate for a workload without one and caps the shard count", () => {
    const shards = packShards(
      Array.from({ length: 20 }, (_, index) => ({ id: `w${index}` })),
      { targetSeconds: 10, maxShards: 3 },
    );

    expect(shards).toHaveLength(3);
    expect(shards.flatMap((shard) => shard.workloads)).toHaveLength(20);
  });

  it("returns no shards for no workloads", () => {
    expect(packShards([])).toEqual([]);
  });
});
