import { createHash } from "node:crypto";
import { Context, Effect, FileSystem, Layer, Option, Path, Result } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { BinaryNotFoundError, ChecksumMismatchError, DownloadError } from "./errors.ts";
import { detectPlatform } from "./Platform.ts";
import {
  nativeReleaseForService,
  type ArchiveFormat,
  type NativeReleaseArtifact,
} from "./ServiceCatalog.ts";
import type { ServiceName } from "./ServiceName.ts";

export interface BinarySpec {
  readonly service: ServiceName;
  readonly version: string;
  readonly cacheDir?: string;
}

interface ResolveBinaryResult {
  readonly path: string;
  readonly downloaded: boolean;
}

export interface ResolveBinaryOptions {
  readonly onDownloadStart?: Effect.Effect<void>;
}

interface AssetInfo {
  readonly service: ServiceName;
  readonly provider: string;
  readonly version: string;
  readonly assetName: string;
}

const cachePath = (baseDir: string, info: AssetInfo): string =>
  `${baseDir}/${info.service}/${info.provider.replaceAll("/", "_")}/${info.version}/${info.assetName}`;

const LEGACY_NATIVE_PROVIDERS: Partial<Record<ServiceName, string>> = {
  postgres: "github.com/supabase/postgres",
  postgrest: "github.com/PostgREST/postgrest",
  auth: "github.com/supabase/auth",
  "edge-runtime": "github.com/supabase/edge-runtime",
};

const legacyCachePath = (baseDir: string, info: AssetInfo): string | undefined =>
  LEGACY_NATIVE_PROVIDERS[info.service] === info.provider
    ? `${baseDir}/${info.service}/${info.version}/${info.assetName}`
    : undefined;

const legacyExecutablePath = (
  directory: string,
  service: ServiceName,
  platformOs: string,
): string | undefined => {
  const executableSuffix = platformOs === "win32" ? ".exe" : "";
  switch (service) {
    case "postgres":
      return `${directory}/bin/postgres${executableSuffix}`;
    case "postgrest":
      return `${directory}/postgrest${executableSuffix}`;
    case "auth":
      return `${directory}/auth${executableSuffix}`;
    case "edge-runtime":
      return `${directory}/bin/edge-runtime${executableSuffix}`;
    default:
      return undefined;
  }
};

const legacyCacheRequiredPaths = (
  directory: string,
  service: ServiceName,
  platformOs: string,
): ReadonlyArray<string> => {
  const executable = legacyExecutablePath(directory, service, platformOs);
  if (executable === undefined) return [];
  return service === "postgres"
    ? [
        executable,
        `${directory}/bin/pg_isready${platformOs === "win32" ? ".exe" : ""}`,
        `${directory}/bin/psql${platformOs === "win32" ? ".exe" : ""}`,
        `${directory}/share/supabase-cli/bin/supabase-postgres-init.sh`,
        `${directory}/lib`,
      ]
    : [executable];
};

const CACHE_COMPLETE_MARKER = ".complete";
const STALE_STAGING_AGE_MS = 24 * 60 * 60 * 1_000;

const extractCommand = (
  archive: ArchiveFormat,
  archivePath: string,
  destDir: string,
  os: string,
  stripComponents: boolean,
): string[] => {
  if (archive === "zip") {
    return os === "win32"
      ? ["tar", "xf", archivePath, "-C", destDir]
      : ["unzip", "-o", archivePath, "-d", destDir];
  }
  const flag = archive === "tar.gz" ? "xzf" : "xf";
  const args = ["tar", flag, archivePath, "-C", destDir];
  if (stripComponents) args.push("--strip-components=1");
  return args;
};

const verifyChecksum = (
  data: ArrayBuffer,
  expected: string,
  url: string,
): Effect.Effect<void, ChecksumMismatchError> =>
  Effect.sync(() => {
    const actual = createHash("sha256").update(new Uint8Array(data)).digest("hex");
    // The .sha256 file typically contains "hex  filename" or just "hex"
    const expectedHex = expected.trim().split(/\s+/)[0] ?? "";
    return { actual, expectedHex };
  }).pipe(
    Effect.flatMap(({ actual, expectedHex }) => {
      if (actual !== expectedHex) {
        return Effect.fail(new ChecksumMismatchError({ url, expected: expectedHex, actual }));
      }
      return Effect.void;
    }),
  );

export class BinaryResolver extends Context.Service<
  BinaryResolver,
  {
    readonly resolveWithMetadata: (
      spec: BinarySpec,
      options?: ResolveBinaryOptions,
    ) => Effect.Effect<
      ResolveBinaryResult,
      BinaryNotFoundError | DownloadError | ChecksumMismatchError
    >;
    readonly resolve: (
      spec: BinarySpec,
    ) => Effect.Effect<string, BinaryNotFoundError | DownloadError | ChecksumMismatchError>;
  }
>()("local/BinaryResolver") {
  // Static pure functions — tested in unit tests
  static cachePath = cachePath;
  static legacyExecutablePath = legacyExecutablePath;
  static legacyCacheRequiredPaths = legacyCacheRequiredPaths;

  static make(
    cacheRoot: string,
  ): Layer.Layer<
    BinaryResolver,
    never,
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient
    | ChildProcessSpawner.ChildProcessSpawner
  > {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const binDir = path.join(cacheRoot, "bin");
        const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        const isCompleteCache = (directory: string) =>
          Effect.gen(function* () {
            if (!(yield* fs.exists(path.join(directory, CACHE_COMPLETE_MARKER)))) {
              return false;
            }
            const entries = yield* fs.readDirectory(directory);
            return entries.some((entry) => entry !== CACHE_COMPLETE_MARKER);
          });

        const isReusableLegacyCache = (
          directory: string,
          service: ServiceName,
          platformOs: string,
        ) => {
          const requiredPaths = legacyCacheRequiredPaths(directory, service, platformOs);
          return requiredPaths.length === 0
            ? Effect.succeed(false)
            : Effect.forEach(requiredPaths, fs.exists).pipe(
                Effect.map((results) => results.every(Boolean)),
              );
        };

        const cleanupStaleStaging = (directory: string, prefix: string) =>
          fs.readDirectory(directory).pipe(
            Effect.flatMap((entries) =>
              Effect.forEach(
                entries.filter((entry) => entry.startsWith(prefix)),
                (entry) => {
                  const stagingPath = path.join(directory, entry);
                  return fs.stat(stagingPath).pipe(
                    Effect.flatMap((info) =>
                      Option.match(info.mtime, {
                        onNone: () => Effect.void,
                        onSome: (modifiedAt) =>
                          Date.now() - modifiedAt.getTime() >= STALE_STAGING_AGE_MS
                            ? fs.remove(stagingPath, { recursive: true, force: true })
                            : Effect.void,
                      }),
                    ),
                    Effect.ignore,
                  );
                },
                { concurrency: 4 },
              ),
            ),
            Effect.ignore,
          );

        const extractRelease = (
          release: NativeReleaseArtifact,
          destination: string,
          platformOs: string,
        ) =>
          Effect.gen(function* () {
            const tarballResponse = yield* httpClient
              .get(release.downloadUrl)
              .pipe(
                Effect.catchTag("HttpClientError", (cause) =>
                  Effect.fail(new DownloadError({ url: release.downloadUrl, cause })),
                ),
              );
            const tarball = yield* tarballResponse.arrayBuffer.pipe(
              Effect.catchTag("HttpClientError", (cause) =>
                Effect.fail(new DownloadError({ url: release.downloadUrl, cause })),
              ),
            );

            const checksumUrl = release.checksumUrl;
            if (checksumUrl !== null) {
              const checksumResponse = yield* httpClient
                .get(checksumUrl)
                .pipe(
                  Effect.catchTag("HttpClientError", (cause) =>
                    Effect.fail(new DownloadError({ url: checksumUrl, cause })),
                  ),
                );
              const checksumText = yield* checksumResponse.text.pipe(
                Effect.catchTag("HttpClientError", (cause) =>
                  Effect.fail(new DownloadError({ url: checksumUrl, cause })),
                ),
              );
              yield* verifyChecksum(tarball, checksumText, checksumUrl);
            }

            const archivePath = path.join(destination, `_download.${release.archive}`);
            yield* fs.writeFile(archivePath, new Uint8Array(tarball));

            const [command, ...args] = extractCommand(
              release.archive,
              archivePath,
              destination,
              platformOs,
              release.stripComponents,
            );
            if (command === undefined) {
              return yield* Effect.fail(
                new DownloadError({
                  url: release.downloadUrl,
                  cause: new Error("No extraction command was configured"),
                }),
              );
            }
            const exitCode = yield* spawner
              .exitCode(ChildProcess.make(command, args))
              .pipe(
                Effect.catchTag("PlatformError", (cause) =>
                  Effect.fail(new DownloadError({ url: release.downloadUrl, cause })),
                ),
              );
            if (exitCode !== 0) {
              return yield* Effect.fail(
                new DownloadError({
                  url: release.downloadUrl,
                  cause: new Error(`extraction exited with code ${exitCode}`),
                }),
              );
            }

            yield* fs.remove(archivePath).pipe(Effect.ignore);

            if (platformOs !== "win32") {
              yield* spawner
                .exitCode(ChildProcess.make("chmod", ["-R", "u+x", destination]))
                .pipe(Effect.ignore);
            }

            if (platformOs === "darwin") {
              yield* spawner
                .exitCode(
                  ChildProcess.make("find", [
                    destination,
                    "-type",
                    "f",
                    "(",
                    "-perm",
                    "+111",
                    "-o",
                    "-name",
                    "*.dylib",
                    ")",
                    "-exec",
                    "codesign",
                    "-f",
                    "-s",
                    "-",
                    "{}",
                    "+",
                  ]),
                )
                .pipe(Effect.ignore);
            }
          });

        const resolveWithMetadata = (spec: BinarySpec, options?: ResolveBinaryOptions) => {
          const core = Effect.gen(function* () {
            const platform = yield* detectPlatform;
            const release = nativeReleaseForService(spec.service, spec.version, platform);
            if (release === undefined) {
              return yield* Effect.fail(
                new BinaryNotFoundError({
                  service: spec.service,
                  platform: `${platform.os}-${platform.arch}`,
                }),
              );
            }

            const info: AssetInfo = {
              service: spec.service,
              provider: release.provider,
              version: spec.version,
              assetName: release.assetName,
            };
            const baseDir = spec.cacheDir ?? binDir;
            const cacheDir = cachePath(baseDir, info);
            const legacyDir = legacyCachePath(baseDir, info);
            const parentDir = path.dirname(cacheDir);
            const stagingPrefix = `.${release.assetName}.partial-`;
            yield* cleanupStaleStaging(parentDir, stagingPrefix);
            if (yield* isCompleteCache(cacheDir)) {
              return {
                path: cacheDir,
                downloaded: false,
              } satisfies ResolveBinaryResult;
            }
            if (
              legacyDir !== undefined &&
              (yield* isReusableLegacyCache(legacyDir, spec.service, platform.os))
            ) {
              return {
                path: legacyDir,
                downloaded: false,
              } satisfies ResolveBinaryResult;
            }

            yield* fs.makeDirectory(parentDir, { recursive: true });
            yield* options?.onDownloadStart ?? Effect.void;

            const stagingDir = yield* fs.makeTempDirectory({
              directory: parentDir,
              prefix: stagingPrefix,
            });
            return yield* Effect.gen(function* () {
              yield* extractRelease(release, stagingDir, platform.os);
              yield* fs.writeFile(
                path.join(stagingDir, CACHE_COMPLETE_MARKER),
                new TextEncoder().encode(
                  JSON.stringify({
                    provider: release.provider,
                    service: spec.service,
                    version: spec.version,
                    asset: release.assetName,
                    url: release.downloadUrl,
                  }),
                ),
              );

              // Each contender publishes from a private staging directory. The
              // first atomic rename wins; later publishers reuse that complete
              // destination instead of coordinating through process identity.
              const publication = yield* fs.rename(stagingDir, cacheDir).pipe(Effect.result);
              if (Result.isSuccess(publication)) {
                return { path: cacheDir, downloaded: true } satisfies ResolveBinaryResult;
              }
              if (yield* isCompleteCache(cacheDir)) {
                return { path: cacheDir, downloaded: false } satisfies ResolveBinaryResult;
              }

              // A fully staged replacement is now available, so an incomplete
              // destination can be reclaimed without risking the last usable
              // cache entry. Retry publication once; persistent filesystem
              // failures still surface instead of looping forever.
              yield* fs.remove(cacheDir, { recursive: true, force: true });
              const retry = yield* fs.rename(stagingDir, cacheDir).pipe(Effect.result);
              if (Result.isSuccess(retry)) {
                return { path: cacheDir, downloaded: true } satisfies ResolveBinaryResult;
              }
              if (yield* isCompleteCache(cacheDir)) {
                return { path: cacheDir, downloaded: false } satisfies ResolveBinaryResult;
              }
              return yield* Effect.fail(retry.failure);
            }).pipe(
              Effect.ensuring(
                fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore),
              ),
            );
          });

          // Absorb PlatformError (from FileSystem ops) into DownloadError
          return core.pipe(
            Effect.catchTag("PlatformError", (e) =>
              Effect.fail(
                new DownloadError({ url: `filesystem error for ${spec.service}`, cause: e }),
              ),
            ),
          );
        };

        return {
          resolveWithMetadata,
          resolve: (spec: BinarySpec) => {
            return Effect.map(resolveWithMetadata(spec), ({ path }) => path);
          },
        };
      }),
    );
  }
}
