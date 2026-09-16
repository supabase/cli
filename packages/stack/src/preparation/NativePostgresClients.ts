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

const versionParts = (version: string): ReadonlyArray<number> =>
  version.split(".").map((part) => Number.parseInt(part, 10));

const compareVersionsDesc = (left: string, right: string): number => {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/** Newest catalog release for a Postgres major; the default release when no major is given. */
const postgresCatalogRelease = (major?: number): WorkloadCatalogRelease | undefined => {
  if (major === undefined) return catalogReleaseFor("database:database");
  const entry = catalogEntryFor("database:database");
  if (entry === undefined) return undefined;
  const matched = Object.keys(entry.releases)
    .filter((release) => versionParts(release)[0] === major)
    .sort(compareVersionsDesc)[0];
  return matched === undefined ? undefined : catalogReleaseFor("database:database", matched);
};

/** Cache path for a prepared postgres slim artifact, when the extra tree is already on disk. */
export const cachedPostgresArtifactRoot = (
  cacheRoot: string,
  major?: number,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const release = postgresCatalogRelease(major);
    const target = targetForPlatform({ os: process.platform, arch: process.arch });
    if (release === undefined || target === undefined) return undefined;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(cacheRoot, "slim-services", "postgres", release.version, target);
    const exists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
    return exists ? root : undefined;
  });
