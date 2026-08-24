import { Data, Effect, FileSystem, Path, Schema } from "effect";

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

class FixtureLoadError extends Data.TaggedError("FixtureLoadError")<{
  readonly path: string;
  readonly cause?: unknown;
}> {}

type FixtureLoadEffect<A> = Effect.Effect<A, FixtureLoadError, FileSystem.FileSystem | Path.Path>;

const parseJson = Schema.fromJsonString(Schema.Unknown);

function parseFixtureFile<T>(path: string): FixtureLoadEffect<T> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (
      !(yield* fs
        .exists(path)
        .pipe(Effect.mapError((cause) => new FixtureLoadError({ path, cause }))))
    ) {
      return yield* new FixtureLoadError({ path, cause: `Missing fixture file: ${path}` });
    }
    const content = yield* fs
      .readFileString(path)
      .pipe(Effect.mapError((cause) => new FixtureLoadError({ path, cause })));
    const value = yield* Schema.decodeEffect(parseJson)(content).pipe(
      Effect.mapError((cause) => new FixtureLoadError({ path, cause })),
    );
    return value as T;
  });
}

/** Load an ordered scenario from scenarios/<name>/interactions.json.
 *  Returns null if the scenario file does not exist — caller decides whether
 *  to fail loudly or fall back to per-endpoint fixtures. */
export function loadScenario(
  scenariosDir: string,
  name: string,
): FixtureLoadEffect<FixtureEntry[] | null> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const scenarioFile = path.join(scenariosDir, name, "interactions.json");
    const fs = yield* FileSystem.FileSystem;
    if (
      !(yield* fs
        .exists(scenarioFile)
        .pipe(Effect.mapError((cause) => new FixtureLoadError({ path: scenarioFile, cause }))))
    )
      return null;
    return yield* parseFixtureFile<FixtureEntry[]>(scenarioFile);
  });
}

/** Load all fixture pairs from the recorded/ directory into a FixtureStore.
 *  Fails fast with a descriptive error if any fixture file is malformed. */
export function loadFixtures(fixturesDir: string): FixtureLoadEffect<FixtureStore> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const recordedDir = path.join(fixturesDir, "recorded");
    const store: FixtureStore = new Map();

    if (
      !(yield* fs
        .exists(recordedDir)
        .pipe(Effect.mapError((cause) => new FixtureLoadError({ path: recordedDir, cause }))))
    )
      return store;

    const directoryEntries = yield* fs
      .readDirectory(recordedDir)
      .pipe(Effect.mapError((cause) => new FixtureLoadError({ path: recordedDir, cause })));
    const keys: Array<string> = [];
    for (const entry of directoryEntries) {
      const info = yield* fs
        .stat(path.join(recordedDir, entry))
        .pipe(Effect.mapError((cause) => new FixtureLoadError({ path: recordedDir, cause })));
      if (info.type === "Directory") keys.push(entry);
    }

    for (const key of keys) {
      const keyDir = path.join(recordedDir, key);
      const files = (yield* fs
        .readDirectory(keyDir)
        .pipe(Effect.mapError((cause) => new FixtureLoadError({ path: keyDir, cause })))).sort();
      const indices = new Set<string>();

      for (const file of files) {
        const match = /^(\d+|default)\.(request|response)\.json$/.exec(file);
        if (match?.[1] !== undefined) indices.add(match[1]);
      }

      const entries: FixtureEntry[] = [];
      for (const index of [...indices].sort(compareIndices)) {
        const [request, response] = yield* Effect.all([
          parseFixtureFile<FixtureRequest>(path.join(keyDir, `${index}.request.json`)),
          parseFixtureFile<FixtureResponse>(path.join(keyDir, `${index}.response.json`)),
        ]);
        entries.push({ request, response });
      }

      if (entries.length > 0) store.set(key, entries);
    }

    return store;
  });
}

/** Sort indices so "default" comes first, then numerically. */
function compareIndices(a: string, b: string): number {
  if (a === "default") return -1;
  if (b === "default") return 1;
  return Number.parseInt(a, 10) - Number.parseInt(b, 10);
}
