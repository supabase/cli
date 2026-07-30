import { createHash, randomUUID } from "node:crypto";
import { Effect, FileSystem, Layer, Path, Context } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { BinaryNotFoundError, ChecksumMismatchError, DownloadError } from "./errors.ts";
import {
  authAssetName,
  detectPlatform,
  edgeRuntimeAssetName,
  postgresAssetName,
  postgrestAssetName,
} from "./Platform.ts";
import type { ServiceName } from "./versions.ts";

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
  readonly version: string;
  readonly assetName: string;
}

const authReleaseTag = (version: string): string =>
  version.includes("-rc.") ? `rc${version}` : `v${version}`;

const downloadUrl = (info: AssetInfo): string => {
  const { service, version, assetName } = info;
  switch (service) {
    case "postgres": {
      // Native binary releases use the "-cli" suffix (e.g. "17.6.1.081-cli")
      const cliVersion = `${version}-cli`;
      return `https://github.com/supabase/postgres/releases/download/v${cliVersion}/supabase-postgres-v${cliVersion}-${assetName}.tar.gz`;
    }
    case "postgrest": {
      const ext = assetName.startsWith("windows") ? "zip" : "tar.xz";
      return `https://github.com/PostgREST/postgrest/releases/download/v${version}/postgrest-v${version}-${assetName}.${ext}`;
    }
    case "auth":
      return `https://github.com/supabase/auth/releases/download/${authReleaseTag(version)}/auth-v${version}-${assetName}.tar.gz`;
    case "edge-runtime":
      return `https://github.com/supabase/edge-runtime/releases/download/v${version}/edge-runtime-v${version}-${assetName}.tar.gz`;
    default:
      throw new Error(`No native binary download available for service: ${service}`);
  }
};

const checksumUrl = (info: AssetInfo): string | null => {
  if (info.service === "postgres") {
    return `${downloadUrl(info)}.sha256`;
  }
  return null;
};

const cachePath = (baseDir: string, info: AssetInfo): string =>
  `${baseDir}/${info.service}/${info.version}/${info.assetName}`;

const extractCommand = (
  url: string,
  archivePath: string,
  destDir: string,
  os: string,
  stripComponents: boolean,
): string[] => {
  if (url.endsWith(".zip")) {
    return os === "win32"
      ? ["tar", "xf", archivePath, "-C", destDir]
      : ["unzip", "-o", archivePath, "-d", destDir];
  }
  const flag = url.endsWith(".tar.gz") ? "xzf" : "xf";
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
  static downloadUrl = downloadUrl;
  static checksumUrl = checksumUrl;
  static cachePath = cachePath;

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

        const resolveWithMetadata = (spec: BinarySpec, options?: ResolveBinaryOptions) => {
          const core = Effect.gen(function* () {
            const platform = yield* detectPlatform;

            // Map service + platform → asset name
            let assetName: string | null;
            switch (spec.service) {
              case "postgres":
                assetName = postgresAssetName(platform);
                break;
              case "postgrest":
                assetName = postgrestAssetName(platform);
                break;
              case "auth":
                assetName = authAssetName(platform);
                break;
              case "edge-runtime":
                assetName = edgeRuntimeAssetName(platform);
                break;
              default:
                assetName = null;
                break;
            }

            if (assetName === null) {
              return yield* Effect.fail(
                new BinaryNotFoundError({
                  service: spec.service,
                  platform: `${platform.os}-${platform.arch}`,
                }),
              );
            }

            const info: AssetInfo = { service: spec.service, version: spec.version, assetName };
            const baseDir = spec.cacheDir ?? binDir;
            const cacheDir = cachePath(baseDir, info);
            const url = downloadUrl(info);

            // Check if already cached (directory exists AND has files). The
            // final cacheDir is only ever created via an atomic rename of a
            // fully-populated staging directory (see below), so a non-empty
            // cacheDir is always a complete, valid cache hit — including when
            // a concurrent process races to resolve the same spec.
            const isCached = yield* fs.exists(cacheDir);
            if (isCached) {
              const entries = yield* fs.readDirectory(cacheDir);
              if (entries.length > 0) {
                return {
                  path: cacheDir,
                  downloaded: false,
                } satisfies ResolveBinaryResult;
              }
              // An empty cacheDir can no longer be produced by this resolver
              // itself; it can only come from external interference (e.g. a
              // pre-atomic-rename cache from an older CLI version). Remove
              // and re-download defensively.
              yield* fs.remove(cacheDir, { recursive: true });
            }

            yield* options?.onDownloadStart ?? Effect.void;

            // Stage the download + extraction in a per-invocation-unique
            // directory sibling to cacheDir, so cacheDir itself only ever
            // becomes visible once fully populated. This prevents concurrent
            // processes resolving the same spec from corrupting each other's
            // downloads/extractions.
            const tmpDir = `${cacheDir}.tmp-${randomUUID()}`;
            const cleanupTmpDir = fs
              .remove(tmpDir, { recursive: true, force: true })
              .pipe(Effect.ignore);

            const stage = Effect.gen(function* () {
              // Download tarball via HttpClient
              const tarballResponse = yield* httpClient
                .get(url)
                .pipe(
                  Effect.catchTag("HttpClientError", (e) =>
                    Effect.fail(new DownloadError({ url, cause: e })),
                  ),
                );
              const tarball = yield* tarballResponse.arrayBuffer.pipe(
                Effect.catchTag("HttpClientError", (e) =>
                  Effect.fail(new DownloadError({ url, cause: e })),
                ),
              );

              // Verify checksum if available
              const csUrl = checksumUrl(info);
              if (csUrl !== null) {
                const csResponse = yield* httpClient
                  .get(csUrl)
                  .pipe(
                    Effect.catchTag("HttpClientError", (e) =>
                      Effect.fail(new DownloadError({ url: csUrl, cause: e })),
                    ),
                  );
                const checksumText = yield* csResponse.text.pipe(
                  Effect.catchTag("HttpClientError", (e) =>
                    Effect.fail(new DownloadError({ url: csUrl, cause: e })),
                  ),
                );
                yield* verifyChecksum(tarball, checksumText, csUrl);
              }

              // Create staging directory
              yield* fs.makeDirectory(tmpDir, { recursive: true });

              // Write archive to a per-invocation-unique temp file
              const ext = url.endsWith(".zip") ? ".zip" : ".tar";
              const tmpFile = path.join(tmpDir, `_download-${randomUUID()}${ext}`);
              yield* fs.writeFile(tmpFile, new Uint8Array(tarball));

              // Extract archive via ChildProcessSpawner
              // Only postgres archives have a wrapping directory that needs stripping
              const stripComponents = spec.service === "postgres";
              const [cmd, ...args] = extractCommand(
                url,
                tmpFile,
                tmpDir,
                platform.os,
                stripComponents,
              );
              const command = ChildProcess.make(cmd!, args);
              const exitCode = yield* spawner
                .exitCode(command)
                .pipe(
                  Effect.catchTag("PlatformError", (cause) =>
                    Effect.fail(new DownloadError({ url, cause })),
                  ),
                );

              if (exitCode !== 0) {
                return yield* Effect.fail(
                  new DownloadError({
                    url,
                    cause: new Error(`extraction exited with code ${exitCode}`),
                  }),
                );
              }

              // Remove temp archive
              yield* fs.remove(tmpFile).pipe(Effect.ignore);

              // Restore execute permissions (tar may strip them depending on umask/platform)
              const chmodCmd = ChildProcess.make("bash", [
                "-c",
                `find "${tmpDir}" -type f \\( -name "*.sh" -o -name "*.dylib" -o -path "*/bin/*" \\) -exec chmod +x {} + && chmod -R u+x "${tmpDir}"`,
              ]);
              yield* spawner.exitCode(chmodCmd).pipe(Effect.ignore);

              // On macOS, ad-hoc code sign all executables and dylibs (defensive).
              // The Go CLI does this after extraction (internal/sandbox/binary.go).
              if (platform.os === "darwin") {
                const codesignCmd = ChildProcess.make("bash", [
                  "-c",
                  `find "${tmpDir}" -type f \\( -perm +111 -o -name "*.dylib" \\) -exec codesign -f -s - {} + 2>/dev/null || true`,
                ]);
                yield* spawner.exitCode(codesignCmd).pipe(Effect.ignore);
              }
            });

            // Clean up the staging directory on any failure (download error,
            // checksum mismatch, extraction failure, or interruption) so no
            // `.tmp-*` directories are left behind in the cache root.
            yield* stage.pipe(Effect.onError(() => cleanupTmpDir));

            // Publish the completed staging directory by atomically renaming
            // it into place. If another process already published cacheDir
            // first, discard our own copy and resolve to theirs instead of
            // failing.
            const published = yield* fs.rename(tmpDir, cacheDir).pipe(
              Effect.as(true),
              Effect.catchTag("PlatformError", (renameError) =>
                fs
                  .exists(cacheDir)
                  .pipe(
                    Effect.flatMap((alreadyPresent) =>
                      alreadyPresent ? Effect.succeed(false) : Effect.fail(renameError),
                    ),
                  ),
              ),
            );
            if (!published) {
              yield* cleanupTmpDir;
            }

            return {
              path: cacheDir,
              downloaded: published,
            } satisfies ResolveBinaryResult;
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
