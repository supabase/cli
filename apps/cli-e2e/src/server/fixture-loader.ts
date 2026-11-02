import { Data, Effect, FileSystem, Formatter, Path, Schema } from "effect";

/* Hand-authored fixtures may omit headers (served as none) and the response body (served empty). */
const FixtureHeaders = Schema.Record(Schema.String, Schema.String).pipe(
  Schema.withDecodingDefaultKey(Effect.sync(() => ({}))),
);

const FixtureRequest = Schema.Struct({
  method: Schema.String,
  path: Schema.mutableKey(Schema.String),
  query: Schema.Record(Schema.String, Schema.String),
  headers: FixtureHeaders,
  body: Schema.Unknown,
});

const FixtureResponse = Schema.Struct({
  status: Schema.Finite,
  headers: FixtureHeaders,
  body: Schema.optionalKey(Schema.Unknown),
});

const FixtureEntry = Schema.Struct({ request: FixtureRequest, response: FixtureResponse });

export type FixtureRequest = typeof FixtureRequest.Type;
export type FixtureResponse = typeof FixtureResponse.Type;
export type FixtureEntry = typeof FixtureEntry.Type;

/** All fixtures indexed by their key (e.g. "GET_v1_projects"), each holding
 *  an ordered queue of entries (for sequential calls to the same endpoint). */
export type FixtureStore = Map<string, FixtureEntry[]>;

/* Mirrors `existsSync`: any failure to reach the path counts as absent. */
export const pathExists = (fs: FileSystem.FileSystem, path: string) =>
  fs.exists(path).pipe(Effect.orElseSucceed(() => false));

/** A fixture file is missing or does not hold valid JSON. */
class FixtureFileError extends Data.Error<{ readonly message: string; readonly cause?: unknown }> {}

/** Load an ordered scenario from scenarios/<name>/interactions.json.
 *  Returns null if the scenario file does not exist — caller decides whether
 *  to fail loudly or fall back to per-endpoint fixtures. */
export const loadScenario = Effect.fn("FixtureLoader.loadScenario")(function* (
  scenariosDir: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scenarioFile = path.join(scenariosDir, name, "interactions.json");
  if (!(yield* pathExists(fs, scenarioFile))) return null;
  const entries: FixtureEntry[] = yield* parseFixtureFile(
    scenarioFile,
    Schema.mutable(Schema.Array(FixtureEntry)),
  );
  return entries;
});

/** Load all fixture pairs from the recorded/ directory into a FixtureStore.
 *  Fails fast with a descriptive error if any fixture file is malformed. */
export const loadFixtures = Effect.fn("FixtureLoader.loadFixtures")(function* (
  fixturesDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const recordedDir = path.join(fixturesDir, "recorded");
  const store: FixtureStore = new Map();

  if (!(yield* pathExists(fs, recordedDir))) {
    return store;
  }

  const keys: string[] = [];
  for (const name of yield* fs.readDirectory(recordedDir)) {
    const info = yield* fs.stat(path.join(recordedDir, name));
    if (info.type === "Directory") keys.push(name);
  }

  for (const key of keys) {
    const keyDir = path.join(recordedDir, key);
    const entries: FixtureEntry[] = [];

    // Collect numbered pairs: 1.request.json/1.response.json, 2.request.json, ...
    // Also accept "default" as an alias for "1".
    const files = (yield* fs.readDirectory(keyDir)).sort();
    const indices = new Set<string>();

    for (const file of files) {
      const match = file.match(/^(\d+|default)\.(request|response)\.json$/);
      if (match?.[1]) indices.add(match[1]);
    }

    for (const index of [...indices].sort(compareIndices)) {
      const reqFile = path.join(keyDir, `${index}.request.json`);
      const resFile = path.join(keyDir, `${index}.response.json`);

      const request = yield* parseFixtureFile(reqFile, FixtureRequest);
      const response = yield* parseFixtureFile(resFile, FixtureResponse);
      entries.push({ request, response });
    }

    if (entries.length > 0) {
      store.set(key, entries);
    }
  }

  yield* Effect.annotateCurrentSpan("fixture.key_count", store.size);
  return store;
});

const parseFixtureFile = Effect.fnUntraced(function* <S extends Schema.Constraint>(
  filePath: string,
  schema: S,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* pathExists(fs, filePath))) {
    return yield* new FixtureFileError({ message: `Missing fixture file: ${filePath}` });
  }
  const malformed = (cause: unknown) =>
    new FixtureFileError({ message: `Malformed fixture file: ${filePath}`, cause });
  const bytes = yield* fs.readFile(filePath).pipe(Effect.mapError(malformed));
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(
      (error) =>
        new FixtureFileError({
          message: `Malformed fixture file: ${filePath}\n  ${error.message}: ${Formatter.format(text.slice(0, 200))}`,
        }),
    ),
  );
});

/** Sort indices so "default" comes first, then numerically. */
function compareIndices(a: string, b: string): number {
  if (a === "default") return -1;
  if (b === "default") return 1;
  return parseInt(a, 10) - parseInt(b, 10);
}
