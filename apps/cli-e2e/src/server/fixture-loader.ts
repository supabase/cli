import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface FixtureRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export interface FixtureResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface FixtureEntry {
  request: FixtureRequest;
  response: FixtureResponse;
}

/** All fixtures indexed by their key (e.g. "GET_v1_projects"), each holding
 *  an ordered queue of entries (for sequential calls to the same endpoint). */
export type FixtureStore = Map<string, FixtureEntry[]>;

/** Load all fixture pairs from the recorded/ directory into a FixtureStore.
 *  Fails fast with a descriptive error if any fixture file is malformed. */
export function loadFixtures(fixturesDir: string): FixtureStore {
  const recordedDir = join(fixturesDir, "recorded");
  const store: FixtureStore = new Map();

  if (!existsSync(recordedDir)) {
    return store;
  }

  const keys = readdirSync(recordedDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const key of keys) {
    const keyDir = join(recordedDir, key);
    const entries: FixtureEntry[] = [];

    // Collect numbered pairs: 1.request.json/1.response.json, 2.request.json, ...
    // Also accept "default" as an alias for "1".
    const files = readdirSync(keyDir).sort();
    const indices = new Set<string>();

    for (const file of files) {
      const match = file.match(/^(\d+|default)\.(request|response)\.json$/);
      if (match?.[1]) indices.add(match[1]);
    }

    for (const index of [...indices].sort(compareIndices)) {
      const reqFile = join(keyDir, `${index}.request.json`);
      const resFile = join(keyDir, `${index}.response.json`);

      const request = parseFixtureFile<FixtureRequest>(reqFile);
      const response = parseFixtureFile<FixtureResponse>(resFile);
      entries.push({ request, response });
    }

    if (entries.length > 0) {
      store.set(key, entries);
    }
  }

  return store;
}

function parseFixtureFile<T>(filePath: string): T {
  if (!existsSync(filePath)) {
    throw new Error(`Missing fixture file: ${filePath}`);
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (cause) {
    throw new Error(`Malformed fixture file: ${filePath}`, { cause });
  }
}

/** Sort indices so "default" comes first, then numerically. */
function compareIndices(a: string, b: string): number {
  if (a === "default") return -1;
  if (b === "default") return 1;
  return parseInt(a, 10) - parseInt(b, 10);
}
