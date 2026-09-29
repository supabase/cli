import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/** Measured e2e file durations in ms, keyed by root-relative path; refreshed from CI artifacts. */
const TIMINGS_FILE = "tests/e2e-timings.json";

/** Duration assumed for every file while no timing has been measured yet. */
export const DEFAULT_DURATION_MS = 30_000;

/** The median of the measured durations, or the default when nothing has been measured. */
export function fallbackDuration(timings: Readonly<Record<string, number>>): number {
  const measured = Object.values(timings).sort((a, b) => a - b);
  if (measured.length === 0) {
    return DEFAULT_DURATION_MS;
  }
  const middle = Math.floor(measured.length / 2);
  const upper = measured[middle] ?? DEFAULT_DURATION_MS;
  if (measured.length % 2 === 1) {
    return upper;
  }
  const lower = measured[middle - 1] ?? upper;
  return (lower + upper) / 2;
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Splits keys into `count` shards by measured duration, longest first into the emptiest shard.
 * The result depends only on the set of keys, so every shard process derives the same partition.
 */
export function packShards(
  keys: readonly string[],
  timings: Readonly<Record<string, number>>,
  count: number,
): string[][] {
  const fallback = fallbackDuration(timings);
  const durations = keys
    .map((key) => ({ key, duration: timings[key] ?? fallback }))
    .sort((a, b) => b.duration - a.duration || compareKeys(a.key, b.key));

  const shards = Array.from({ length: count }, () => ({ load: 0, keys: new Array<string>() }));
  for (const { key, duration } of durations) {
    let target = shards[0];
    for (const shard of shards) {
      if (target === undefined || shard.load < target.load) {
        target = shard;
      }
    }
    if (target !== undefined) {
      target.load += duration;
      target.keys.push(key);
    }
  }
  return shards.map((shard) => shard.keys);
}

function isTimings(value: unknown): value is Readonly<Record<string, number>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (duration) => typeof duration === "number" && Number.isFinite(duration),
    )
  );
}

/** Reads the committed timings file under `root`; anything but a map of finite numbers reads as absent. */
export function readTimings(root: string): Readonly<Record<string, number>> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve(root, TIMINGS_FILE), "utf8"));
    return isTimings(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shards the e2e project by measured duration. Other projects, and the e2e project while
 * the timings file is absent, keep Vitest's hash split.
 */
export class E2eSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    const timings = files.every((spec) => spec.project.name === "e2e")
      ? readTimings(root)
      : undefined;
    if (shard === undefined || timings === undefined) {
      return super.shard(files);
    }

    const byKey = new Map(
      files.map((spec) => [relative(root, spec.moduleId).replaceAll("\\", "/"), spec]),
    );
    const assigned = packShards([...byKey.keys()], timings, shard.count)[shard.index - 1] ?? [];
    return assigned.flatMap((key) => {
      const spec = byKey.get(key);
      return spec === undefined ? [] : [spec];
    });
  }
}
