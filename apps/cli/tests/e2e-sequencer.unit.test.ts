import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_DURATION_MS, fallbackDuration, packShards, readTimings } from "./e2e-sequencer.ts";

const files = ["src/a.e2e.test.ts", "src/b.e2e.test.ts", "src/c.e2e.test.ts", "src/d.e2e.test.ts"];

const sortedShards = (shards: readonly (readonly string[])[]) =>
  shards.map((shard) => [...shard].sort());

describe("packShards", () => {
  test.each([1, files.length, files.length + 3])(
    "partitions every file into exactly one of %i shards",
    (count) => {
      const shards = packShards(files, { "src/a.e2e.test.ts": 100 }, count);

      expect(shards).toHaveLength(count);
      expect(shards.flat().sort()).toEqual([...files].sort());
    },
  );

  test("leaves trailing shards empty when there are more shards than files", () => {
    const shards = packShards(["src/a.e2e.test.ts", "src/b.e2e.test.ts"], {}, 4);

    expect(shards).toEqual([["src/a.e2e.test.ts"], ["src/b.e2e.test.ts"], [], []]);
  });

  test("produces the same partition regardless of input order", () => {
    const timings = {
      "src/a.e2e.test.ts": 500,
      "src/b.e2e.test.ts": 200,
      "src/c.e2e.test.ts": 900,
    };

    const forward = packShards(files, timings, 2);
    const reversed = packShards([...files].reverse(), timings, 2);

    expect(reversed).toEqual(forward);
  });

  test("isolates a file that outweighs all the others combined", () => {
    const timings = {
      "src/a.e2e.test.ts": 10,
      "src/b.e2e.test.ts": 1_000,
      "src/c.e2e.test.ts": 10,
      "src/d.e2e.test.ts": 10,
    };

    const shards = packShards(files, timings, 2);

    expect(sortedShards(shards)).toEqual([
      ["src/b.e2e.test.ts"],
      ["src/a.e2e.test.ts", "src/c.e2e.test.ts", "src/d.e2e.test.ts"],
    ]);
  });

  test("weights an unmeasured file at the median of the measured ones", () => {
    const timings = {
      "src/a.e2e.test.ts": 100,
      "src/b.e2e.test.ts": 300,
      "src/c.e2e.test.ts": 500,
    };

    // d is unmeasured; at the median (300) it ties with b and follows it into the second shard.
    const shards = packShards(files, timings, 2);

    expect(sortedShards(shards)).toEqual([
      ["src/a.e2e.test.ts", "src/c.e2e.test.ts"],
      ["src/b.e2e.test.ts", "src/d.e2e.test.ts"],
    ]);
  });

  test("weights every file at the default duration when nothing has been measured", () => {
    const allDefault = Object.fromEntries(files.map((file) => [file, DEFAULT_DURATION_MS]));

    expect(packShards(files, {}, 3)).toEqual(packShards(files, allDefault, 3));
  });

  test("breaks duration ties by key so equal files spread deterministically", () => {
    const timings = { "src/c.e2e.test.ts": 50, "src/a.e2e.test.ts": 50, "src/b.e2e.test.ts": 50 };

    const shards = packShards(Object.keys(timings), timings, 3);

    expect(shards).toEqual([["src/a.e2e.test.ts"], ["src/b.e2e.test.ts"], ["src/c.e2e.test.ts"]]);
  });
});

describe("fallbackDuration", () => {
  test("is the default duration when nothing has been measured", () => {
    expect(fallbackDuration({})).toBe(DEFAULT_DURATION_MS);
  });

  test("is the middle value for an odd number of measurements", () => {
    expect(fallbackDuration({ a: 900, b: 100, c: 300 })).toBe(300);
  });

  test("is the mean of the two middle values for an even number of measurements", () => {
    expect(fallbackDuration({ a: 100, b: 200, c: 400, d: 900 })).toBe(300);
  });
});

describe("readTimings", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "e2e-timings-"));
    mkdirSync(join(root, "tests"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeTimings = (content: string) =>
    writeFileSync(join(root, "tests", "e2e-timings.json"), content);

  test("reads the files map from a version 1 envelope", () => {
    writeTimings(
      JSON.stringify({
        version: 1,
        files: { "src/a.e2e.test.ts": 1200, "src/b.e2e.test.ts": 300 },
      }),
    );

    expect(readTimings(root)).toEqual({ "src/a.e2e.test.ts": 1200, "src/b.e2e.test.ts": 300 });
  });

  test("reads as absent when the file is missing", () => {
    expect(readTimings(root)).toBeUndefined();
  });

  test("reads as absent rather than half-applying when any duration is not a number", () => {
    writeTimings(
      JSON.stringify({
        version: 1,
        files: { "src/a.e2e.test.ts": 1200, "src/b.e2e.test.ts": "300" },
      }),
    );

    expect(readTimings(root)).toBeUndefined();
  });

  test("reads as absent when the file is not JSON", () => {
    writeTimings("{ not json");

    expect(readTimings(root)).toBeUndefined();
  });

  test("reads as absent for a flat map with no envelope", () => {
    writeTimings(JSON.stringify({ "src/a.e2e.test.ts": 1200, "src/b.e2e.test.ts": 300 }));

    expect(readTimings(root)).toBeUndefined();
  });

  test("reads as absent for an unknown envelope version", () => {
    writeTimings(JSON.stringify({ version: 2, files: { "src/a.e2e.test.ts": 1200 } }));

    expect(readTimings(root)).toBeUndefined();
  });
});
