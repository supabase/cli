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
      `db.orioledb_version = ${orioledb} requires a published OrioleDB artifact; supported OrioleDB versions: ${
        supported.length === 0 ? "none" : supported.join(", ")
      }`,
    );
  const major = postgresMajor(orioledb);
  if (major !== String(db.major_version))
    return Result.fail(
      `db.orioledb_version = ${orioledb} requires db.major_version = ${major} for the experimental stack`,
    );
  return Result.succeed(orioledbPostgresVersion(orioledb));
};
