import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rmdir } from "node:fs/promises";
import { uptime } from "node:os";
import { Context, Data, Effect, FileSystem, Layer, Option, Path, Result, Schedule } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { BinaryNotFoundError, ChecksumMismatchError, DownloadError } from "./errors.ts";
import { detectPlatform } from "./Platform.ts";
import {
  nativeReleaseForService,
  type ArchiveFormat,
  type NativeReleaseArtifact,
} from "./ServiceArtifacts.ts";
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
    ? [executable, `${directory}/share/supabase-cli/bin/supabase-postgres-init.sh`]
    : [executable];
};

const CACHE_COMPLETE_MARKER = ".complete";
const LEGACY_CACHE_LOCK_OWNER_FILE = "owner.pid";
const CACHE_LOCK_OWNER_PREFIX = "owner.";
const CACHE_LOCK_OWNER_GRACE_MS = 5_000;
const STALE_STAGING_AGE_MS = 24 * 60 * 60 * 1_000;
const CACHE_LOCK_RETRY_SCHEDULE = Schedule.spaced("100 millis");

interface CacheLockOwner {
  readonly pid: number;
  readonly bootMinute: number;
  readonly startIdentity?: string;
}

const currentBootMinute = (): number => Math.round((Date.now() - uptime() * 1_000) / 60_000);

const processStartIdentity = (pid: number): string | undefined => {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fieldsAfterCommand = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const startTicks = fieldsAfterCommand[19];
      return startTicks === undefined ? undefined : `linux:${startTicks}`;
    }
    if (process.platform === "win32") {
      const ticks = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 },
      ).trim();
      return ticks.length === 0 ? undefined : `win32:${ticks}`;
    }
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return started.length === 0 ? undefined : `${process.platform}:${started}`;
  } catch {
    return undefined;
  }
};

const cacheLockOwnerContent = (): string => {
  const startIdentity = processStartIdentity(process.pid);
  const owner: CacheLockOwner = {
    pid: process.pid,
    bootMinute: currentBootMinute(),
    ...(startIdentity === undefined ? {} : { startIdentity }),
  };
  return JSON.stringify(owner);
};

const parseCacheLockOwner = (content: string): CacheLockOwner | undefined => {
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "pid" in parsed &&
      typeof parsed.pid === "number" &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      "bootMinute" in parsed &&
      typeof parsed.bootMinute === "number" &&
      Number.isSafeInteger(parsed.bootMinute) &&
      (!("startIdentity" in parsed) || typeof parsed.startIdentity === "string")
    ) {
      const startIdentity =
        "startIdentity" in parsed && typeof parsed.startIdentity === "string"
          ? parsed.startIdentity
          : undefined;
      return {
        pid: parsed.pid,
        bootMinute: parsed.bootMinute,
        ...(startIdentity === undefined ? {} : { startIdentity }),
      };
    }
    if (typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0) {
      return { pid: parsed, bootMinute: currentBootMinute() };
    }
  } catch {}
  return undefined;
};

const cacheLockOwnerFile = (): string => `${CACHE_LOCK_OWNER_PREFIX}${process.pid}.${randomUUID()}`;

const isCacheLockOwnerFile = (entry: string): boolean =>
  entry === LEGACY_CACHE_LOCK_OWNER_FILE || entry.startsWith(CACHE_LOCK_OWNER_PREFIX);

const removeEmptyDirectory = (directory: string): Effect.Effect<void> =>
  Effect.promise(() => rmdir(directory).catch(() => undefined));

class CacheLockBusy extends Data.TaggedError("CacheLockBusy")<{
  readonly path: string;
}> {}

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
                { concurrency: "unbounded" },
              ),
            ),
            Effect.ignore,
          );

        const acquireCacheLock = (
          lockPath: string,
          url: string,
        ): Effect.Effect<
          { readonly lockPath: string; readonly ownerPath: string },
          DownloadError
        > => {
          const isProcessAlive = (owner: CacheLockOwner) =>
            Effect.sync(() => {
              if (Math.abs(owner.bootMinute - currentBootMinute()) > 2) {
                return false;
              }
              try {
                process.kill(owner.pid, 0);
                return (
                  owner.startIdentity === undefined ||
                  processStartIdentity(owner.pid) === owner.startIdentity
                );
              } catch (error) {
                return !(
                  typeof error === "object" &&
                  error !== null &&
                  "code" in error &&
                  error.code === "ESRCH"
                );
              }
            });

          const reclaimStaleLock = Effect.gen(function* () {
            const info = yield* fs.stat(lockPath).pipe(Effect.option);
            if (Option.isNone(info)) {
              return;
            }
            const modifiedAt = Option.getOrUndefined(info.value.mtime);
            const isPastOwnerGrace =
              modifiedAt !== undefined &&
              Date.now() - modifiedAt.getTime() >= CACHE_LOCK_OWNER_GRACE_MS;
            const entries = yield* fs.readDirectory(lockPath).pipe(Effect.option);
            if (Option.isNone(entries)) {
              return;
            }
            const ownerFiles = entries.value.filter(isCacheLockOwnerFile);
            if (ownerFiles.length === 0) {
              if (!isPastOwnerGrace) return;
            }

            const observedOwners = new Map<string, string>();
            for (const ownerFile of ownerFiles) {
              const ownerPath = path.join(lockPath, ownerFile);
              const owner = yield* fs.readFileString(ownerPath).pipe(Effect.option);
              if (Option.isSome(owner)) {
                const parsedOwner = parseCacheLockOwner(owner.value);
                if (parsedOwner !== undefined) {
                  if (yield* isProcessAlive(parsedOwner)) {
                    return;
                  }
                  observedOwners.set(ownerFile, owner.value);
                  continue;
                }
              }
              if (!isPastOwnerGrace) {
                return;
              }
              observedOwners.set(
                ownerFile,
                Option.getOrElse(owner, () => ""),
              );
            }

            const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
            const moved = yield* fs.rename(lockPath, quarantinePath).pipe(Effect.result);
            if (Result.isFailure(moved)) {
              return;
            }

            const quarantineEntries = yield* fs.readDirectory(quarantinePath).pipe(Effect.option);
            if (Option.isNone(quarantineEntries)) {
              return;
            }
            const quarantinedOwnerFiles = quarantineEntries.value.filter(isCacheLockOwnerFile);
            let observedStillMatches = quarantinedOwnerFiles.length === observedOwners.size;
            for (const ownerFile of quarantinedOwnerFiles) {
              const content = yield* fs
                .readFileString(path.join(quarantinePath, ownerFile))
                .pipe(Effect.option);
              if (Option.isNone(content) || observedOwners.get(ownerFile) !== content.value) {
                observedStillMatches = false;
              }
            }
            if (!observedStillMatches) {
              yield* fs.rename(quarantinePath, lockPath).pipe(Effect.ignore);
              return;
            }
            yield* fs.remove(quarantinePath, { recursive: true, force: true }).pipe(Effect.ignore);
          });

          const acquire: Effect.Effect<
            { readonly lockPath: string; readonly ownerPath: string },
            CacheLockBusy | DownloadError
          > = Effect.gen(function* () {
            const result = yield* fs.makeDirectory(lockPath).pipe(Effect.result);
            if (Result.isSuccess(result)) {
              const ownerPath = path.join(lockPath, cacheLockOwnerFile());
              const ownerResult = yield* fs
                .writeFileString(ownerPath, cacheLockOwnerContent())
                .pipe(Effect.result);
              if (Result.isFailure(ownerResult)) {
                yield* fs.remove(ownerPath, { force: true }).pipe(Effect.ignore);
                yield* removeEmptyDirectory(lockPath);
                return yield* Effect.fail(new DownloadError({ url, cause: ownerResult.failure }));
              }
              const ownerInstalled = yield* fs
                .exists(ownerPath)
                .pipe(Effect.mapError((cause) => new DownloadError({ url, cause })));
              if (!ownerInstalled) {
                return yield* Effect.fail(new CacheLockBusy({ path: lockPath }));
              }
              return { lockPath, ownerPath };
            }

            const error = result.failure;
            if (error.reason._tag !== "AlreadyExists") {
              return yield* Effect.fail(new DownloadError({ url, cause: error }));
            }

            yield* reclaimStaleLock;
            return yield* Effect.fail(new CacheLockBusy({ path: lockPath }));
          });

          return acquire.pipe(
            Effect.retry({
              while: (error) => error._tag === "CacheLockBusy",
              schedule: CACHE_LOCK_RETRY_SCHEDULE,
            }),
            Effect.catchTag("CacheLockBusy", (error) =>
              Effect.fail(
                new DownloadError({
                  url,
                  cause: new Error(`Timed out waiting for artifact cache lock: ${error.path}`),
                }),
              ),
            ),
          );
        };

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
            const lockPath = `${cacheDir}.lock`;

            return yield* Effect.acquireUseRelease(
              acquireCacheLock(lockPath, release.downloadUrl),
              () =>
                Effect.gen(function* () {
                  if (yield* isCompleteCache(cacheDir)) {
                    return {
                      path: cacheDir,
                      downloaded: false,
                    } satisfies ResolveBinaryResult;
                  }

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
                    yield* fs.remove(cacheDir, { recursive: true, force: true });
                    yield* fs.rename(stagingDir, cacheDir);
                    return {
                      path: cacheDir,
                      downloaded: true,
                    } satisfies ResolveBinaryResult;
                  }).pipe(
                    Effect.ensuring(
                      fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore),
                    ),
                  );
                }),
              ({ lockPath: acquiredLockPath, ownerPath }) =>
                Effect.gen(function* () {
                  yield* fs.remove(ownerPath, { force: true }).pipe(Effect.ignore);
                  yield* removeEmptyDirectory(acquiredLockPath);
                }),
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
