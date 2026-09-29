// Rewrites apps/cli/tests/e2e-timings.json from the Vitest results caches that the test-e2e
// workflow job uploads as `e2e-timings-<shard>` artifacts.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { version as installedVitestVersion } from "vitest/node";
import { readResultsCaches, type VitestResultsCache } from "./vitest-results-cache.ts";

export type { VitestResultsCache } from "./vitest-results-cache.ts";

export interface MergeOptions {
  /** Version of the Vitest that will consume the timings; caches from another major are rejected. */
  readonly vitestVersion: string;
  readonly warn?: (message: string) => void;
}

const PROJECT_PREFIX = "e2e:";

function major(version: string): string {
  return version.split(".")[0] ?? version;
}

/**
 * Merges e2e project entries from several results caches into `{ path: ms }`, sorted by path.
 * Failed entries are skipped since their duration reflects the failure, not the file.
 */
export function mergeTimings(
  caches: ReadonlyArray<VitestResultsCache>,
  { vitestVersion, warn = () => {} }: MergeOptions,
): Record<string, number> {
  const merged = new Map<string, number>();
  for (const cache of caches) {
    if (major(cache.version) !== major(vitestVersion)) {
      throw new Error(
        `results cache was written by Vitest ${cache.version} but Vitest ${vitestVersion} is installed`,
      );
    }
    for (const [key, result] of cache.results) {
      if (!key.startsWith(PROJECT_PREFIX)) {
        continue;
      }
      const path = key.slice(PROJECT_PREFIX.length);
      if (result.failed) {
        warn(`skipping failed ${path}`);
        continue;
      }
      const duration = Math.round(result.duration);
      merged.set(path, Math.max(merged.get(path) ?? 0, duration));
    }
  }
  return Object.fromEntries([...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const usage = `Usage: pnpm exec bun apps/cli/scripts/refresh-e2e-timings.ts --run <run-id> [--repo supabase/cli]

  Downloads the e2e-timings-* artifacts of a test workflow run and rewrites
  apps/cli/tests/e2e-timings.json from them.`;

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { run: { type: "string" }, repo: { type: "string", default: "supabase/cli" } },
  });
  if (!values.run) {
    console.error(usage);
    process.exit(2);
  }

  const downloadDir = mkdtempSync(join(tmpdir(), "e2e-timings-"));
  try {
    const download = spawnSync(
      "gh",
      [
        "run",
        "download",
        values.run,
        "--repo",
        values.repo,
        "--pattern",
        "e2e-timings-*",
        "--dir",
        downloadDir,
      ],
      { stdio: "inherit" },
    );
    if (download.error !== undefined) {
      throw new Error(`could not run gh: ${download.error.message}`);
    }
    if (download.status !== 0) {
      throw new Error(
        `gh run download exited with ${download.status ?? `signal ${download.signal}`}`,
      );
    }

    const caches = readResultsCaches(downloadDir);
    if (caches.length === 0) {
      throw new Error(`no results.json found in the e2e-timings-* artifacts of run ${values.run}`);
    }
    const timings = mergeTimings(caches, {
      vitestVersion: installedVitestVersion,
      warn: (message) => console.error(message),
    });
    const target = fileURLToPath(new URL("../tests/e2e-timings.json", import.meta.url));
    writeFileSync(target, `${JSON.stringify({ version: 1, files: timings }, null, 2)}\n`);
    console.error(`wrote ${Object.keys(timings).length} timings to ${target}`);
  } catch (cause) {
    console.error(`error: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}
