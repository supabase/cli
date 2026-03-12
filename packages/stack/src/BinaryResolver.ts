import { createHash } from "node:crypto";
import { Effect, FileSystem, Layer, Path, ServiceMap } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { BinaryNotFoundError, ChecksumMismatchError, DownloadError } from "./errors.ts";
import {
  authAssetName,
  detectPlatform,
  postgresAssetName,
  postgrestAssetName,
} from "./Platform.ts";
import type { ServiceName } from "./versions.ts";

export interface BinarySpec {
  readonly service: ServiceName;
  readonly version: string;
  readonly cacheDir?: string;
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

export class BinaryResolver extends ServiceMap.Service<
  BinaryResolver,
  {
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
    home: string,
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
        const binDir = path.join(home, "bin");
        const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        return {
          resolve: (spec: BinarySpec) => {
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

              // Check if already cached (directory exists AND has files)
              const isCached = yield* fs.exists(cacheDir);
              if (isCached) {
                const entries = yield* fs.readDirectory(cacheDir);
                if (entries.length > 0) {
                  return cacheDir;
                }
                // Empty directory from a failed extraction — remove and re-download
                yield* fs.remove(cacheDir, { recursive: true });
              }

              // Download tarball via HttpClient
              const url = downloadUrl(info);
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

              // Create cache directory
              yield* fs.makeDirectory(cacheDir, { recursive: true });

              // Write archive to temp file
              const ext = url.endsWith(".zip") ? ".zip" : ".tar";
              const tmpFile = path.join(cacheDir, `_download${ext}`);
              yield* fs.writeFile(tmpFile, new Uint8Array(tarball));

              // Extract archive via ChildProcessSpawner
              // Only postgres archives have a wrapping directory that needs stripping
              const stripComponents = spec.service === "postgres";
              const [cmd, ...args] = extractCommand(
                url,
                tmpFile,
                cacheDir,
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
                `find "${cacheDir}" -type f \\( -name "*.sh" -o -name "*.dylib" -o -path "*/bin/*" \\) -exec chmod +x {} + && chmod -R u+x "${cacheDir}"`,
              ]);
              yield* spawner.exitCode(chmodCmd).pipe(Effect.ignore);

              // On macOS, ad-hoc code sign all executables and dylibs (defensive).
              // The Go CLI does this after extraction (internal/sandbox/binary.go).
              if (platform.os === "darwin") {
                const codesignCmd = ChildProcess.make("bash", [
                  "-c",
                  `find "${cacheDir}" -type f \\( -perm +111 -o -name "*.dylib" \\) -exec codesign -f -s - {} + 2>/dev/null || true`,
                ]);
                yield* spawner.exitCode(codesignCmd).pipe(Effect.ignore);
              }

              return cacheDir;
            });

            // Absorb PlatformError (from FileSystem ops) into DownloadError
            return core.pipe(
              Effect.catchTag("PlatformError", (e) =>
                Effect.fail(
                  new DownloadError({ url: `filesystem error for ${spec.service}`, cause: e }),
                ),
              ),
            );
          },
        };
      }),
    );
  }
}
