import { Data, Effect, Schema } from "effect";
import type { FileSystem, Path } from "effect";
import { isOrioledbVersion, postgresMajor } from "../Artifacts.ts";

/** Recovery for local database data a stack cannot reuse, worded like the CLI's saved-stack advice. */
export const recreateStackAdvice = (stackId: string): string =>
  `run \`supabase stack destroy --stack-id ${stackId}\` to recreate the stack — this permanently deletes its local database data`;

/** Recovery that keeps data created at `version` by pinning it again, before the destructive recreate. */
export const keepOrRecreateAdvice = (stackId: string, service: string, version: string): string =>
  `keep this data by pinning \`[local.services.${service}] version = "${version}"\` in supabase/config.toml, or ${recreateStackAdvice(stackId)}`;

/** The runtimes a database runs under. */
export const DatabaseRuntime = Schema.Literals(["native", "docker", "podman"]);
export type DatabaseRuntime = typeof DatabaseRuntime.Type;

/**
 * What initialized PostgreSQL data was created by: its release line, major and upstream build. Only
 * a slim-services revision of the same build can reuse it.
 */
export const DatabaseIdentity = Schema.Struct({
  line: Schema.Literals(["stock", "orioledb"]),
  major: Schema.String,
  build: Schema.String,
});
export interface DatabaseIdentity extends Schema.Schema.Type<typeof DatabaseIdentity> {}

/** The identity a database artifact version initializes. */
export const databaseIdentity = (version: string): DatabaseIdentity => ({
  line: isOrioledbVersion(version) ? "orioledb" : "stock",
  major: postgresMajor(version),
  build: version,
});

/** Whether two identities describe the same line, major and build. */
export const sameDatabaseIdentity = (a: DatabaseIdentity, b: DatabaseIdentity): boolean =>
  a.line === b.line && a.major === b.major && a.build === b.build;

const describeIdentity = (identity: DatabaseIdentity): string =>
  `${identity.line === "orioledb" ? "OrioleDB" : "stock PostgreSQL"} build ${identity.build}`;

/** Existing database data was created by a different build, line or major than the one requested. */
export class DatabaseIdentityMismatch extends Schema.TaggedError<DatabaseIdentityMismatch>()(
  "DatabaseIdentityMismatch",
  {
    message: Schema.String,
    recorded: Schema.optionalKey(DatabaseIdentity),
    requested: DatabaseIdentity,
  },
) {}

/**
 * How to keep data `recorded` created: pin its build, which selects its line, plus the `[db]` edits
 * that keep the pin valid whichever setting selected the requested build.
 */
const keepDatabaseAdvice = (
  stackId: string,
  recorded: DatabaseIdentity,
  requested: DatabaseIdentity,
): string => {
  const edits = [
    ...(recorded.major === requested.major
      ? []
      : [`setting \`[db] major_version = ${recorded.major}\``]),
    ...(requested.line === "orioledb" ? ["removing any `[db] orioledb_version`"] : []),
  ];
  if (edits.length === 0) return keepOrRecreateAdvice(stackId, "database", recorded.build);
  const clauses = new Intl.ListFormat("en", { type: "conjunction" }).format([
    `pinning \`[local.services.database] version = "${recorded.build}"\``,
    ...edits,
  ]);
  return `keep this data by ${clauses} in supabase/config.toml, or ${recreateStackAdvice(stackId)}`;
};

/**
 * The failure to reuse existing database data for `version`, or `undefined` when it can serve it.
 * Data with no recorded identity cannot be verified, so it is refused.
 */
export const databaseIdentityMismatch = (
  stackId: string,
  recorded: DatabaseIdentity | undefined,
  version: string,
): DatabaseIdentityMismatch | undefined => {
  const requested = databaseIdentity(version);
  if (recorded !== undefined && sameDatabaseIdentity(recorded, requested)) return undefined;
  const subject =
    recorded === undefined
      ? "PostgreSQL data has no recorded identity"
      : `PostgreSQL data was initialized by ${describeIdentity(recorded)}`;
  const advice =
    recorded === undefined
      ? recreateStackAdvice(stackId)
      : keepDatabaseAdvice(stackId, recorded, requested);
  return new DatabaseIdentityMismatch({
    message: `${subject}, but ${describeIdentity(requested)} was requested; ${advice}`,
    ...(recorded === undefined ? {} : { recorded }),
    requested,
  });
};

/** Written once a database's bootstrap completed; its presence marks initialized data. */
export const databaseReadyMarkerFile = ".supabase-database-ready.json";

/** The content of {@link databaseReadyMarkerFile}. */
export const DatabaseReadyMarker = Schema.Struct({
  runtime: DatabaseRuntime,
  profile: Schema.Literal("supabase"),
});
export interface DatabaseReadyMarker extends Schema.Schema.Type<typeof DatabaseReadyMarker> {}

const identityFile = ".supabase-database-identity.json";
const IdentityJson = Schema.fromJsonString(DatabaseIdentity);

/** The identity recorded for an instance's data, or `undefined` when none was recorded. */
export const readDatabaseIdentity = Effect.fn("Database.readIdentity")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  instanceRoot: string,
) {
  const file = path.join(instanceRoot, identityFile);
  if (!(yield* fs.exists(file))) return undefined;
  return yield* fs.readFileString(file).pipe(Effect.flatMap(Schema.decodeEffect(IdentityJson)));
});

/** Forgets an instance's data identity together with its data. */
export const removeDatabaseIdentity = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  instanceRoot: string,
) => fs.remove(path.join(instanceRoot, identityFile), { force: true });

/** Records an instance's data identity; callers write it before initdb so an interrupted first start keeps it. */
export const recordDatabaseIdentity = Effect.fn("Database.recordIdentity")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  instanceRoot: string,
  identity: DatabaseIdentity,
) {
  const encoded = yield* Schema.encodeEffect(IdentityJson)(identity);
  const stage = yield* fs.makeTempDirectoryScoped({
    directory: instanceRoot,
    prefix: ".identity-",
  });
  yield* fs.writeFileString(path.join(stage, "marker"), encoded, { mode: 0o600 });
  yield* fs.rename(path.join(stage, "marker"), path.join(instanceRoot, identityFile));
}, Effect.scoped);

/** What a start at one runtime finds under an instance root. */
export type DatabaseDataState = Data.TaggedEnum<{
  Fresh: {};
  Initialized: {};
  RuntimeMismatch: { readonly recorded: DatabaseRuntime };
}>;
export const DatabaseDataState = Data.taggedEnum<DatabaseDataState>();

/**
 * How a start at `runtime` treats what it found: a readiness marker means initialized data of the
 * runtime that wrote it, and a bare `PG_VERSION` (an interrupted first start) counts only natively,
 * since a Docker volume is invisible to the host and its storage is checked at launch.
 */
export const databaseDataState = (
  runtime: DatabaseRuntime,
  found: { readonly marker: DatabaseReadyMarker | undefined; readonly pgVersion: boolean },
): DatabaseDataState => {
  if (found.marker !== undefined)
    return found.marker.runtime === runtime
      ? DatabaseDataState.Initialized()
      : DatabaseDataState.RuntimeMismatch({ recorded: found.marker.runtime });
  return runtime === "native" && found.pgVersion
    ? DatabaseDataState.Initialized()
    : DatabaseDataState.Fresh();
};

/** The {@link databaseDataState} of the data under `instanceRoot`. */
export const readDatabaseDataState = Effect.fn("Database.dataState")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  instanceRoot: string,
  runtime: DatabaseRuntime,
) {
  const markerPath = path.join(instanceRoot, databaseReadyMarkerFile);
  const marker = (yield* fs.exists(markerPath))
    ? yield* fs
        .readFileString(markerPath)
        .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(DatabaseReadyMarker))))
    : undefined;
  const pgVersion =
    marker === undefined && (yield* fs.exists(path.join(instanceRoot, "data", "PG_VERSION")));
  return databaseDataState(runtime, { marker, pgVersion });
});

/**
 * Whether `instanceRoot` holds initialized database data: a readiness marker, or a PostgreSQL data
 * directory an interrupted first start left behind. A Docker volume is invisible to the host, so
 * only its marker counts here; the launch guard checks its storage.
 */
const databaseDataInitialized = Effect.fn("Database.dataInitialized")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  instanceRoot: string,
) {
  const initialized =
    (yield* fs.exists(path.join(instanceRoot, databaseReadyMarkerFile))) ||
    (yield* fs.exists(path.join(instanceRoot, "data", "PG_VERSION")));
  yield* Effect.annotateCurrentSpan({ "database.data.initialized": initialized });
  return initialized;
});

/** The ids of the saved database instances under `dataRoot` whose data is initialized. */
export const initializedDatabaseIds = Effect.fn("Database.initializedIds")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  dataRoot: string,
  instances: ReadonlyArray<{
    readonly id: string;
    readonly creation: { readonly service: string };
  }>,
) {
  const databases = instances.filter(({ creation }) => creation.service === "database");
  const initialized = yield* Effect.filter(databases, ({ id }) =>
    databaseDataInitialized(fs, path, path.join(dataRoot, id)),
  );
  return new Set(initialized.map(({ id }) => id));
});
