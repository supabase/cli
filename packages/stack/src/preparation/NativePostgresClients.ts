import { Effect, FileSystem, Path } from "effect";
import {
  catalogEntryFor,
  catalogReleaseFor,
  targetForPlatform,
  type WorkloadCatalogRelease,
} from "../model/WorkloadCatalog.ts";

export type NativePostgresClientCommand = "pg_dump" | "pg_dumpall" | "psql";

/** Artifact `bin` when the extra client exists. Missing is normal, not an integrity failure. */
export const nativePostgresClientBinDir = (
  artifactRoot: string,
  command: NativePostgresClientCommand,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(artifactRoot, "bin");
    const exists = yield* fs
      .exists(path.join(binDir, command))
      .pipe(Effect.orElseSucceed(() => false));
    return exists ? binDir : undefined;
  });

const postgresCatalogRelease = (version?: string): WorkloadCatalogRelease | undefined => {
  if (version === undefined) return catalogReleaseFor("database:database");
  const exact = catalogReleaseFor("database:database", version);
  if (exact !== undefined) return exact;
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major)) return undefined;
  const entry = catalogEntryFor("database:database");
  if (entry === undefined) return undefined;
  const matched = Object.keys(entry.releases).find(
    (release) => Number.parseInt(release.split(".")[0] ?? "", 10) === major,
  );
  return matched === undefined ? undefined : catalogReleaseFor("database:database", matched);
};

/** Cache path for a prepared postgres slim artifact, when the extra tree is already on disk. */
export const cachedPostgresArtifactRoot = (
  cacheRoot: string,
  version?: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const release = postgresCatalogRelease(version);
    const target = targetForPlatform({ os: process.platform, arch: process.arch });
    if (release === undefined || target === undefined) return undefined;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(cacheRoot, "slim-services", "postgres", release.version, target);
    const exists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
    return exists ? root : undefined;
  });
