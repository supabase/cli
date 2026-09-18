import { Effect } from "effect";
import { StackVersionUnsupportedError } from "../public/Errors.ts";
import { catalogEntryFor, catalogReleaseFor } from "./WorkloadCatalog.ts";

export interface PostgresRelease {
  readonly version: string;
  readonly image: string;
}

/** Resolves an exact or major PostgreSQL catalog release for client tooling. */
export const resolvePostgresRelease = (
  version?: string,
): Effect.Effect<PostgresRelease, StackVersionUnsupportedError> => {
  const entry = catalogEntryFor("database:database");
  const requested = version ?? entry.defaultVersion;
  const exact = catalogReleaseFor("database:database", requested);
  const major = requested.split(".")[0];
  const majorVersion =
    major === undefined
      ? undefined
      : Object.keys(entry.releases).find((candidate) => candidate.split(".")[0] === major);
  const selected =
    exact ??
    (majorVersion === undefined ? undefined : catalogReleaseFor("database:database", majorVersion));
  if (selected === undefined)
    return Effect.fail(
      new StackVersionUnsupportedError({
        message: `Unsupported PostgreSQL version ${requested}`,
        version: requested,
        capability: "database",
      }),
    );
  return Effect.succeed({ version: selected.version, image: selected.containerImage });
};
