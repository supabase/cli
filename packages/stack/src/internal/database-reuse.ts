import { Effect, Schema } from "effect";
import type { FileSystem, Path } from "effect";
import { isOrioledbVersion, postgresMajor } from "../Artifacts.ts";

/** Recovery for local database data a stack cannot reuse, worded like the CLI's saved-stack advice. */
export const recreateStackAdvice = (stackId: string): string =>
  `run \`supabase stack destroy --stack-id ${stackId}\` to recreate the stack — this permanently deletes its local database data`;

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
  return new DatabaseIdentityMismatch({
    message: `${subject}, but ${describeIdentity(requested)} was requested; ${recreateStackAdvice(stackId)}`,
    ...(recorded === undefined ? {} : { recorded }),
    requested,
  });
};

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
