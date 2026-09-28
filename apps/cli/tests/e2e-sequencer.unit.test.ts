import { describe, expect, test } from "vitest";
import { assignShards } from "./e2e-sequencer.ts";

describe("assignShards", () => {
  test("partitions every path into exactly one shard", () => {
    const paths = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts"];
    const secondsByPath = { "a.test.ts": 168, "b.test.ts": 96, "c.test.ts": 10 };

    for (let count = 1; count <= 4; count++) {
      const shards = assignShards(paths, secondsByPath, count);
      expect(shards).toHaveLength(count);
      const assigned = shards.flat();
      expect(assigned.slice().sort()).toEqual(paths.slice().sort());
      expect(new Set(assigned).size).toBe(paths.length);
    }
  });

  test("balances a small fixture by longest-first greedy assignment", () => {
    const paths = ["heavy.test.ts", "medium.test.ts", "light-a.test.ts", "light-b.test.ts"];
    const secondsByPath = {
      "heavy.test.ts": 100,
      "medium.test.ts": 60,
      "light-a.test.ts": 20,
      "light-b.test.ts": 20,
    };

    const shards = assignShards(paths, secondsByPath, 2);

    expect(shards).toEqual([
      ["heavy.test.ts"],
      ["medium.test.ts", "light-a.test.ts", "light-b.test.ts"],
    ]);
  });
});
