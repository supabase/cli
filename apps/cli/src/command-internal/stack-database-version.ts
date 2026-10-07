import {
  orioledbPostgresVersion,
  orioledbVersions,
  postgresMajor,
} from "@supabase/stack/internal/artifacts";
import { Result } from "effect";

/**
 * Database artifact version the stack runs for a project's `[db]` config: the major alias, or the
 * OrioleDB build named by `db.orioledb_version`, which must be pinned in the artifact catalog.
 */
export const stackDatabaseVersion = (
  db: { readonly major_version: number; readonly orioledb_version?: string | undefined },
  supported: ReadonlyArray<string> = orioledbVersions(),
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
