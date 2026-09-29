// Shared parsing for Vitest's results cache (normally at
// `<workspace>/node_modules/.vite/vitest/<hash>/results.json`, staged by `test.yml` as
// `<workspace>/<hash>/results.json` before upload — see the "Stage ... test timings" steps),
// used both by `apps/cli/scripts/refresh-e2e-timings.ts` and the weekly test-health report.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

interface VitestFileResult {
  readonly duration: number;
  readonly failed: boolean;
}

/** Shape of Vitest's `results.json` cache: `[<project>:<root-relative path>, result]` entries. */
export interface VitestResultsCache {
  readonly version: string;
  readonly results: ReadonlyArray<readonly [string, VitestFileResult]>;
}

function isFileResult(value: unknown): value is VitestFileResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "duration" in value &&
    typeof value.duration === "number" &&
    "failed" in value &&
    typeof value.failed === "boolean"
  );
}

function isResultsEntry(value: unknown): value is readonly [string, VitestFileResult] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    isFileResult(value[1])
  );
}

export function isResultsCache(value: unknown): value is VitestResultsCache {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string" &&
    "results" in value &&
    Array.isArray(value.results) &&
    value.results.every(isResultsEntry)
  );
}

/** Reads every `results.json` found recursively under `dir`. */
export function readResultsCaches(dir: string): VitestResultsCache[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === "results.json")
    .map((entry) => {
      const file = join(entry.parentPath, entry.name);
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isResultsCache(parsed)) {
        throw new Error(`${file} is not a Vitest results cache`);
      }
      return parsed;
    });
}

/** A single project entry from a results cache, with the `<project>:` prefix split out and the
 * owning workspace (e.g. `apps/cli`) derived from where the cache file was found under `dir`. */
export interface VitestResultEntry {
  readonly workspace: string;
  readonly project: string;
  readonly path: string;
  readonly duration: number;
  readonly failed: boolean;
}

function splitKey(key: string): { readonly project: string; readonly path: string } {
  const separator = key.indexOf(":");
  return separator === -1
    ? { project: "", path: key }
    : { project: key.slice(0, separator), path: key.slice(separator + 1) };
}

/** The `unit-timings`/`integration-timings`/`e2e-timings-*` artifacts stage each workspace's
 * results caches under `<workspace>/<hash>/results.json` before upload (see `test.yml`), so the
 * workspace is the `apps/<name>` or `packages/<name>` segment pair found in the cache's directory
 * path; a path with neither (e.g. an artifact predating that staging step) is `"."`. */
function workspaceFromCachePath(relativeDir: string): string {
  const segments = relativeDir.split(/[/\\]+/);
  const index = segments.findIndex((segment) => segment === "apps" || segment === "packages");
  return index === -1 || segments[index + 1] === undefined
    ? "."
    : `${segments[index]}/${segments[index + 1]}`;
}

/** Flattens every results cache found (recursively) under `dir` into entries carrying the
 * workspace, project, path, duration, and failed flag. */
export function readResultEntries(dir: string): VitestResultEntry[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === "results.json")
    .flatMap((entry) => {
      const file = join(entry.parentPath, entry.name);
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isResultsCache(parsed)) {
        throw new Error(`${file} is not a Vitest results cache`);
      }
      const workspace = workspaceFromCachePath(relative(dir, entry.parentPath));
      return parsed.results.map(([key, result]) => {
        const { project, path } = splitKey(key);
        return { workspace, project, path, duration: result.duration, failed: result.failed };
      });
    });
}
