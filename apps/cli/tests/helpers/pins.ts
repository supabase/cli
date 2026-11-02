import {
  databaseArtifactPin,
  orioledbPostgresVersion,
  orioledbVersions,
} from "@supabase/stack/internal/artifacts";
import { defaultArtifactSelection } from "@supabase/stack/defaults";
import { Effect } from "effect";

/** The compiled default pin of every service kind. */
export const selection = defaultArtifactSelection();

/** The PostgreSQL 15 database pin, the non-default stock line. */
export const database15 = Effect.runSync(databaseArtifactPin("15"));

/** The `[db] orioledb_version` value of the catalog's OrioleDB build. */
export const [orioledbConfigVersion = ""] = orioledbVersions();

/** The OrioleDB database pin. */
export const orioledb = Effect.runSync(
  databaseArtifactPin(orioledbPostgresVersion(orioledbConfigVersion)),
);
