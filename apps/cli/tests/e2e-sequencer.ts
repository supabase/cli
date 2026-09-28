import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

export function assignShards(
  paths: readonly string[],
  secondsByPath: Readonly<Record<string, number>>,
  count: number,
): string[][] {
  const shards: string[][] = Array.from({ length: count }, () => []);
  const loads: number[] = Array.from({ length: count }, () => 0);
  const ordered = [...paths].sort((a, b) => {
    const weightDiff = (secondsByPath[b] ?? 1) - (secondsByPath[a] ?? 1);
    return weightDiff !== 0 ? weightDiff : a.localeCompare(b);
  });

  for (const path of ordered) {
    const target = loads.indexOf(Math.min(...loads));
    shards[target]?.push(path);
    loads[target] = (loads[target] ?? 0) + (secondsByPath[path] ?? 1);
  }

  return shards;
}

// Approximate CI seconds per e2e file; unlisted files count as 1. Refresh when shard times drift.
const secondsByPath: Readonly<Record<string, number>> = {
  "src/commands/start/start.lifecycle.e2e.test.ts": 168,
  "src/commands/db/schema/declarative/sync/sync.e2e.test.ts": 96,
  "src/command-internal/db-bootstrap/shadow-cache.e2e.test.ts": 85,
  "src/commands/start/start.slim-images.e2e.test.ts": 68,
  "src/commands/db/diff/diff.declarative.e2e.test.ts": 59,
  "src/commands/stop/stop.e2e.test.ts": 57,
  "src/commands/status/status.e2e.test.ts": 31,
  "src/commands/functions/serve/serve.stack.e2e.test.ts": 26,
  "src/commands/db/start/start.e2e.test.ts": 17,
  "src/commands/experimental/stack/start/start.e2e.test.ts": 15,
  "src/commands/db/reset/reset.stack.e2e.test.ts": 11,
  "src/commands/db/start/start.roles.e2e.test.ts": 11,
  "src/commands/db/diff/diff.stack-cache.e2e.test.ts": 11,
  "src/shared/functions/serve-main-offline.e2e.test.ts": 10,
};

export class DurationBalancedSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (shard === undefined) return files;
    const byPath = new Map(files.map((file) => [relative(root, file.moduleId), file] as const));
    const assigned = assignShards([...byPath.keys()], secondsByPath, shard.count);
    const target = assigned[shard.index - 1] ?? [];
    return target.map((path) => {
      const file = byPath.get(path);
      if (file === undefined) throw new Error(`Unresolved shard entry: ${path}`);
      return file;
    });
  }
}
