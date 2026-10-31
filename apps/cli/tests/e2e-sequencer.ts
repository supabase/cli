import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/** Bun `--timings` file of measured e2e file durations, refreshed from CI artifacts. */
const TIMINGS_FILE = "tests/e2e-timings.json";
const E2E_PROJECT = "e2e";
const E2E_EXCLUSIVE_PROJECT = "e2e-exclusive";
const E2E_PROJECTS = new Set([E2E_PROJECT, E2E_EXCLUSIVE_PROJECT]);

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

/** An e2e file to shard; exclusive files run one at a time after the concurrent ones. */
export interface ShardFile {
  readonly key: string;
  readonly exclusive: boolean;
}

interface ShardLoad {
  readonly longestConcurrent: number;
  readonly concurrentTotal: number;
  readonly exclusiveTotal: number;
}

function withFile(load: ShardLoad, duration: number, exclusive: boolean): ShardLoad {
  return exclusive
    ? { ...load, exclusiveTotal: load.exclusiveTotal + duration }
    : {
        ...load,
        longestConcurrent: Math.max(load.longestConcurrent, duration),
        concurrentTotal: load.concurrentTotal + duration,
      };
}

function estimatedWall(load: ShardLoad, workers: number): number {
  return Math.max(load.longestConcurrent, load.concurrentTotal / workers) + load.exclusiveTotal;
}

/**
 * Splits files into `count` shards by estimated wall time, longest first into the shard whose
 * estimate stays lowest, the less loaded one on ties. Concurrent files share `workers` slots;
 * exclusive files add their full duration.
 * The result depends only on the set of files, so every shard process derives the same partition.
 */
export function packShards(
  files: readonly ShardFile[],
  timings: Readonly<Record<string, number>>,
  count: number,
  workers: number,
): string[][] {
  const fallback = fallbackDuration(timings);
  const durations = files
    .map((file) => ({ ...file, duration: timings[file.key] ?? fallback }))
    .sort((a, b) => b.duration - a.duration || compareKeys(a.key, b.key));

  const empty: ShardLoad = { longestConcurrent: 0, concurrentTotal: 0, exclusiveTotal: 0 };
  const shards = Array.from({ length: count }, () => ({ keys: new Array<string>(), load: empty }));
  for (const { key, exclusive, duration } of durations) {
    let target:
      | { shard: (typeof shards)[number]; load: ShardLoad; wall: number; before: number }
      | undefined;
    for (const shard of shards) {
      const load = withFile(shard.load, duration, exclusive);
      const wall = estimatedWall(load, workers);
      const before = estimatedWall(shard.load, workers);
      if (
        target === undefined ||
        wall < target.wall ||
        (wall === target.wall && before < target.before)
      ) {
        target = { shard, load, wall, before };
      }
    }
    if (target !== undefined) {
      target.shard.load = target.load;
      target.shard.keys.push(key);
    }
  }
  return shards.map((shard) => shard.keys);
}

function isFilesMap(value: unknown): value is Readonly<Record<string, number>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (duration) => typeof duration === "number" && Number.isFinite(duration),
    )
  );
}

function isTimingsEnvelope(
  value: unknown,
): value is { version: 1; files: Readonly<Record<string, number>> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "files" in value &&
    isFilesMap(value.files)
  );
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Reads the committed Bun `--timings` file under `root`; anything but that envelope reads as absent. */
export const readTimings = Effect.fn("E2eSequencer.readTimings")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFile(path.resolve(root, TIMINGS_FILE)).pipe(
    Effect.map((bytes) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)),
    Effect.flatMap(decodeJson),
    Effect.map((parsed): Readonly<Record<string, number>> | undefined =>
      isTimingsEnvelope(parsed) ? parsed.files : undefined,
    ),
    Effect.orElseSucceed(() => undefined),
  );
});

const sequencerLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

class HashSplitFailed extends Data.TaggedError("HashSplitFailed")<{ readonly cause: unknown }> {}

/**
 * Shards the e2e projects by measured duration. Other projects, and the e2e projects while
 * the timings file is absent, keep Vitest's hash split.
 */
export class E2eSequencer extends BaseSequencer {
  override shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    const hashSplit = () => super.shard(files);
    return Effect.runPromise(
      Effect.gen(function* () {
        const timings = files.every((spec) => E2E_PROJECTS.has(spec.project.name))
          ? yield* readTimings(root)
          : undefined;
        if (shard === undefined || timings === undefined) {
          return yield* Effect.tryPromise({
            try: hashSplit,
            catch: (cause) => new HashSplitFailed({ cause }),
          });
        }

        const path = yield* Path.Path;
        const byKey = new Map(
          files.map((spec) => [path.relative(root, spec.moduleId).replaceAll("\\", "/"), spec]),
        );
        const shardFiles = [...byKey].map(([key, spec]) => ({
          key,
          exclusive: spec.project.name === E2E_EXCLUSIVE_PROJECT,
        }));
        const maxWorkers =
          files.find((spec) => spec.project.name === E2E_PROJECT)?.project.config.maxWorkers ?? 1;
        // Concurrent files share one Docker daemon and slow each other, so pack against half the slots.
        const workers = Math.max(1, Math.floor(maxWorkers / 2));
        const assigned =
          packShards(shardFiles, timings, shard.count, workers)[shard.index - 1] ?? [];
        return assigned.flatMap((key) => {
          const spec = byKey.get(key);
          return spec === undefined ? [] : [spec];
        });
      }).pipe(
        Effect.provide(sequencerLayer),
        Effect.catchTag("HashSplitFailed", (error) => Effect.die(error.cause)),
      ),
    );
  }
}
