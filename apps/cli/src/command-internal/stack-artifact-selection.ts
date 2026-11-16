import {
  databaseArtifactPin,
  orioledbPostgresVersion,
  orioledbVersions,
  postgresMajor,
  type ArtifactSelection,
} from "@supabase/stack/internal/artifacts";
import { defaultArtifactSelection } from "@supabase/stack/defaults";
import { Effect, Result, Schema } from "effect";

/** A `[db]` config asks for a database release the experimental stack cannot run. */
export class StackArtifactSelectionError extends Schema.TaggedError<StackArtifactSelectionError>()(
  "StackArtifactSelectionError",
  { message: Schema.String },
) {}

type DatabaseSettings = {
  readonly major_version: number;
  readonly orioledb_version?: string | undefined;
};

/** The database release a `[db]` config asks for: its major, or the OrioleDB build it names. */
const requestedDatabaseVersion = (
  db: DatabaseSettings,
  supported: ReadonlyArray<string>,
): Result.Result<string, string> => {
  const orioledb = db.orioledb_version;
  if (orioledb === undefined || orioledb.length === 0)
    return Result.succeed(String(db.major_version));
  if (!supported.includes(orioledb))
    return Result.fail(
      `db.orioledb_version (or SUPABASE_DB_ORIOLEDB_VERSION) = ${orioledb} is not an OrioleDB build this CLI ships for the experimental stack; it ships: ${
        supported.length === 0 ? "none" : supported.join(", ")
      }. A stack keeps the build it was created with, so moving an existing stack to another build means recreating it with supabase stack destroy, which permanently deletes its local database data`,
    );
  const major = postgresMajor(orioledb);
  if (major !== String(db.major_version))
    return Result.fail(
      `db.orioledb_version (or SUPABASE_DB_ORIOLEDB_VERSION) = ${orioledb} requires db.major_version (or SUPABASE_DB_MAJOR_VERSION) = ${major} for the experimental stack`,
    );
  return Result.succeed(orioledbPostgresVersion(orioledb));
};

/**
 * The artifact pins a stack command runs: the compiled defaults, with the database pin chosen by
 * the project's `[db]` config. Built once per command and written into every creation.
 */
export const stackArtifactSelection = (
  db: DatabaseSettings,
  supported: ReadonlyArray<string> = orioledbVersions(),
): Effect.Effect<ArtifactSelection, StackArtifactSelectionError> =>
  Effect.fromResult(requestedDatabaseVersion(db, supported)).pipe(
    Effect.mapError((message) => new StackArtifactSelectionError({ message })),
    Effect.flatMap((version) =>
      databaseArtifactPin(version).pipe(
        Effect.mapError((error) => new StackArtifactSelectionError({ message: error.message })),
      ),
    ),
    Effect.map((database) => ({ ...defaultArtifactSelection(), database })),
  );
