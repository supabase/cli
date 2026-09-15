import { Effect, FileSystem, Path } from "effect";
import { catalogReleaseFor, targetForPlatform } from "../model/WorkloadCatalog.ts";

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

/** Cache path for a prepared postgres slim artifact, when the extra tree is already on disk. */
export const cachedPostgresArtifactRoot = (
  cacheRoot: string,
  version?: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const release =
      catalogReleaseFor("database:database", version) ?? catalogReleaseFor("database:database");
    const target = targetForPlatform({ os: process.platform, arch: process.arch });
    if (release === undefined || target === undefined) return undefined;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(cacheRoot, "slim-services", "postgres", release.version, target);
    const exists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
    return exists ? root : undefined;
  });
