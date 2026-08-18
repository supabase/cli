import { createHash } from "node:crypto";
import { Context, Effect, FileSystem, Layer, Option, Path, Result } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  BinaryHostCompatibilityError,
  BinaryManifestError,
  BinaryNotFoundError,
  BinaryRuntimeError,
  ChecksumMismatchError,
  DownloadError,
} from "./errors.ts";
import { detectPlatform, type NativeTarget } from "./Platform.ts";
import { nativeReleaseForService, type NativeReleaseArtifact } from "./ServiceCatalog.ts";
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

interface SlimServiceManifest {
  readonly service: string;
  readonly version: string;
  readonly target: string;
  readonly entrypoint: ReadonlyArray<string>;
  readonly cmd: ReadonlyArray<string>;
  readonly runtime_requires?: null | "glibc";
  readonly libc: null | "glibc";
  readonly os_floor: null | {
    readonly kind: string;
    readonly floor: string | null;
    readonly offender?: string | null;
    readonly scanned: number;
    readonly bundled_glibc?: boolean;
  };
}

export interface ResolveBinaryOptions {
  readonly onDownloadStart?: Effect.Effect<void>;
}

interface AssetInfo {
  readonly service: ServiceName;
  readonly releaseSet: "slim-services";
  readonly version: string;
  readonly runtime: "native";
  readonly target: NativeTarget;
}

interface CacheCompleteMarker {
  readonly provider: string;
  readonly service: string;
  readonly version: string;
  readonly asset: string;
  readonly url: string;
  readonly target: NativeTarget;
  readonly releaseSet: "slim-services";
  readonly runtime: "native";
}

const cachePath = (baseDir: string, info: AssetInfo): string =>
  `${baseDir}/${info.releaseSet}/${info.service}/${info.version}/${info.runtime}/${info.target}`;

const CACHE_COMPLETE_MARKER = ".complete";
const STALE_STAGING_AGE_MS = 24 * 60 * 60 * 1_000;

const extractCommand = (archivePath: string, destDir: string): string[] => {
  const args = ["tar", "--zstd", "-xf", archivePath, "-C", destDir];
  return args;
};

const hasTraversalSegment = (value: string): boolean =>
  value.split(/[\\/]/).some((segment) => segment === "..");

const isUnsafeArchiveMember = (member: string): boolean => {
  const normalized = member.trim();
  if (normalized.length === 0) return false;
  if (normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized)) return true;
  let depth = 0;
  for (const segment of normalized.split(/[\\/]/)) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (depth === 0) return true;
      depth -= 1;
    } else {
      depth += 1;
    }
  }
  return false;
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

const checksumForArchive = (contents: string, archiveName: string): string | undefined => {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+[* ]?(.+)$/i);
    if (match?.[2] === archiveName || match?.[2]?.endsWith(`/${archiveName}`)) return match[1];
  }
  const single = contents.trim().match(/^([a-f0-9]{64})(?:\s|$)/i);
  return single?.[1];
};

const manifestError = (url: string, detail: string): BinaryManifestError =>
  new BinaryManifestError({ url, detail });

const isSlimServiceManifest = (value: unknown): value is SlimServiceManifest => {
  if (typeof value !== "object" || value === null) return false;
  if (!("service" in value) || typeof value.service !== "string") return false;
  if (!("version" in value) || typeof value.version !== "string") return false;
  if (!("target" in value) || typeof value.target !== "string") return false;
  if (!("entrypoint" in value) || !Array.isArray(value.entrypoint)) return false;
  if (!("cmd" in value) || !Array.isArray(value.cmd)) return false;
  if (
    "runtime_requires" in value &&
    value.runtime_requires !== null &&
    value.runtime_requires !== "glibc"
  )
    return false;
  if (!("libc" in value) || (value.libc !== null && value.libc !== "glibc")) return false;
  if (!("os_floor" in value)) return false;
  if (value.os_floor !== null) {
    if (typeof value.os_floor !== "object") return false;
    if (!("kind" in value.os_floor) || typeof value.os_floor.kind !== "string") return false;
    if (!("floor" in value.os_floor)) return false;
    if (value.os_floor.floor !== null && typeof value.os_floor.floor !== "string") return false;
    if (!("scanned" in value.os_floor) || typeof value.os_floor.scanned !== "number") return false;
    if (
      "offender" in value.os_floor &&
      value.os_floor.offender !== null &&
      typeof value.os_floor.offender !== "string"
    )
      return false;
    if ("bundled_glibc" in value.os_floor && typeof value.os_floor.bundled_glibc !== "boolean")
      return false;
  }
  return true;
};

const validateManifest = (
  release: NativeReleaseArtifact,
  raw: unknown,
  platform: { readonly os: string; readonly arch: string },
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): Effect.Effect<SlimServiceManifest, BinaryManifestError | BinaryHostCompatibilityError> =>
  Effect.gen(function* () {
    if (typeof raw !== "object" || raw === null) {
      return yield* Effect.fail(manifestError(release.manifestUrl, "Manifest must be an object"));
    }
    if (!isSlimServiceManifest(raw)) {
      return yield* Effect.fail(manifestError(release.manifestUrl, "Manifest schema is invalid"));
    }
    const manifest = raw;
    if (
      manifest.service !== release.service ||
      manifest.version !== release.version ||
      manifest.target !== release.target
    ) {
      return yield* Effect.fail(
        manifestError(
          release.manifestUrl,
          "Manifest service/version/target does not match release",
        ),
      );
    }
    if (
      !Array.isArray(manifest.entrypoint) ||
      !manifest.entrypoint.every((value) => typeof value === "string") ||
      !Array.isArray(manifest.cmd) ||
      !manifest.cmd.every((value) => typeof value === "string")
    ) {
      return yield* Effect.fail(
        manifestError(release.manifestUrl, "Manifest entrypoint/cmd must be string arrays"),
      );
    }
    if (manifest.entrypoint.length === 0 && manifest.cmd.length === 0) {
      return yield* Effect.fail(manifestError(release.manifestUrl, "Manifest has no command"));
    }
    const runtimeRequires = manifest.runtime_requires ?? null;
    const commandPaths = [...manifest.entrypoint, ...manifest.cmd].filter(
      (entry) =>
        entry.startsWith("/") ||
        entry.includes("/") ||
        entry.includes("\\") ||
        entry === "." ||
        entry === "..",
    );
    if (commandPaths.some((entry) => hasTraversalSegment(entry))) {
      return yield* Effect.fail(
        manifestError(release.manifestUrl, "Manifest command path is unsafe"),
      );
    }
    const osFloor = manifest.os_floor;
    if (osFloor !== null && typeof osFloor !== "object") {
      return yield* Effect.fail(manifestError(release.manifestUrl, "Manifest os_floor is invalid"));
    }
    const requiresGlibc = manifest.libc === "glibc" || runtimeRequires === "glibc";
    if (requiresGlibc && platform.os !== "linux") {
      return yield* Effect.fail(
        new BinaryHostCompatibilityError({
          target: release.target,
          detail: "Manifest requires Linux/glibc",
        }),
      );
    }
    if (osFloor !== null && osFloor.kind === "macos" && platform.os !== "darwin") {
      return yield* Effect.fail(
        new BinaryHostCompatibilityError({
          target: release.target,
          detail: "Manifest requires macOS",
        }),
      );
    }
    if (osFloor !== null && osFloor.kind === "glibc" && platform.os !== "linux") {
      return yield* Effect.fail(
        new BinaryHostCompatibilityError({
          target: release.target,
          detail: "Manifest requires Linux/glibc",
        }),
      );
    }
    if (osFloor !== null && osFloor.kind !== "macos" && osFloor.kind !== "glibc") {
      return yield* Effect.fail(
        new BinaryHostCompatibilityError({
          target: release.target,
          detail: `Unsupported manifest host kind ${osFloor.kind}`,
        }),
      );
    }
    const floor = osFloor?.floor;
    if (
      platform.os === "linux" &&
      osFloor?.kind === "glibc" &&
      floor !== null &&
      floor !== undefined
    ) {
      const host = yield* Effect.sync(() => {
        try {
          const report = process.report?.getReport?.();
          if (typeof report !== "object" || report === null || !("header" in report)) {
            return undefined;
          }
          const header = report.header;
          if (
            typeof header !== "object" ||
            header === null ||
            !("glibcVersionRuntime" in header) ||
            typeof header.glibcVersionRuntime !== "string"
          ) {
            return undefined;
          }
          return header.glibcVersionRuntime;
        } catch {
          return undefined;
        }
      });
      if (typeof host !== "string" || host.trim().length === 0) {
        return yield* Effect.fail(
          new BinaryHostCompatibilityError({
            target: release.target,
            detail: "Unable to determine host glibc version",
          }),
        );
      }
      if (compareVersions(host, floor) < 0) {
        return yield* Effect.fail(
          new BinaryHostCompatibilityError({
            target: release.target,
            detail: `Host glibc ${host} is below manifest floor ${floor}`,
          }),
        );
      }
    }
    if (
      platform.os === "darwin" &&
      osFloor?.kind === "macos" &&
      floor !== null &&
      floor !== undefined
    ) {
      const host = yield* spawner.string(ChildProcess.make("sw_vers", ["-productVersion"])).pipe(
        Effect.mapError(
          (cause) =>
            new BinaryHostCompatibilityError({
              target: release.target,
              detail: `Unable to determine macOS version: ${String(cause)}`,
            }),
        ),
      );
      const hostVersion = host.trim().split(/\s+/)[0] ?? "";
      if (hostVersion.length === 0) {
        return yield* Effect.fail(
          new BinaryHostCompatibilityError({
            target: release.target,
            detail: "Unable to determine macOS version",
          }),
        );
      }
      if (compareVersions(hostVersion, floor) < 0) {
        return yield* Effect.fail(
          new BinaryHostCompatibilityError({
            target: release.target,
            detail: `Host macOS ${hostVersion} is below manifest floor ${floor}`,
          }),
        );
      }
    }
    return manifest;
  });

const compareVersions = (left: string, right: string): number => {
  const a = left.split(".").map((part) => Number(part) || 0);
  const b = right.split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

export class BinaryResolver extends Context.Service<
  BinaryResolver,
  {
    /** Computes the immutable cache identity without inspecting or changing the filesystem. */
    readonly plan: (spec: BinarySpec) => Effect.Effect<string, BinaryNotFoundError>;
    readonly resolveWithMetadata: (
      spec: BinarySpec,
      options?: ResolveBinaryOptions,
    ) => Effect.Effect<
      ResolveBinaryResult,
      | BinaryNotFoundError
      | DownloadError
      | ChecksumMismatchError
      | BinaryManifestError
      | BinaryRuntimeError
      | BinaryHostCompatibilityError
    >;
    readonly resolve: (
      spec: BinarySpec,
    ) => Effect.Effect<
      string,
      | BinaryNotFoundError
      | DownloadError
      | ChecksumMismatchError
      | BinaryManifestError
      | BinaryRuntimeError
      | BinaryHostCompatibilityError
    >;
  }
>()("local/BinaryResolver") {
  // Static pure functions — tested in unit tests
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

        const isCacheCompleteMarker = (value: unknown): value is CacheCompleteMarker => {
          if (typeof value !== "object" || value === null) return false;
          if (!("provider" in value) || typeof value.provider !== "string") return false;
          if (!("service" in value) || typeof value.service !== "string") return false;
          if (!("version" in value) || typeof value.version !== "string") return false;
          if (!("asset" in value) || typeof value.asset !== "string") return false;
          if (!("url" in value) || typeof value.url !== "string") return false;
          if (
            !("target" in value) ||
            (value.target !== "darwin-arm64" &&
              value.target !== "linux-amd64" &&
              value.target !== "linux-arm64")
          )
            return false;
          if (!("releaseSet" in value) || value.releaseSet !== "slim-services") return false;
          if (!("runtime" in value) || value.runtime !== "native") return false;
          return true;
        };

        const isCompleteCache = (
          directory: string,
          release: NativeReleaseArtifact,
          info: AssetInfo,
        ) =>
          Effect.gen(function* () {
            const marker = yield* fs
              .readFileString(path.join(directory, CACHE_COMPLETE_MARKER))
              .pipe(Effect.option);
            if (Option.isNone(marker)) return false;
            const parsed = yield* Effect.try({
              try: () => JSON.parse(marker.value),
              catch: () => undefined,
            });
            if (!isCacheCompleteMarker(parsed)) return false;
            if (
              parsed.provider !== release.provider ||
              parsed.service !== info.service ||
              parsed.version !== info.version ||
              parsed.asset !== release.assetName ||
              parsed.url !== release.downloadUrl ||
              parsed.target !== info.target ||
              parsed.releaseSet !== info.releaseSet ||
              parsed.runtime !== info.runtime
            ) {
              return false;
            }
            const requiredPaths = [...new Set(release.requiredRuntimePaths)];
            const present = yield* Effect.forEach(requiredPaths, (entry) =>
              fs.exists(path.join(directory, entry)),
            );
            return present.every(Boolean);
          }).pipe(Effect.catch(() => Effect.succeed(false)));

        const plan = (spec: BinarySpec): Effect.Effect<string, BinaryNotFoundError> =>
          Effect.gen(function* () {
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
              releaseSet: "slim-services",
              version: spec.version,
              runtime: "native",
              target: release.target,
            };
            return cachePath(spec.cacheDir ?? binDir, info);
          });

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

        const validateExtractedTree = (directory: string) =>
          Effect.gen(function* () {
            const root = yield* fs.realPath(directory);
            const entries = yield* fs.readDirectory(directory, { recursive: true });
            for (const entry of entries) {
              const candidate = path.join(directory, entry);
              const resolved = yield* fs.realPath(candidate).pipe(
                Effect.mapError(
                  () =>
                    new BinaryRuntimeError({
                      path: candidate,
                      detail: "Extracted path cannot be resolved inside private staging",
                    }),
                ),
              );
              const relative = path.relative(root, resolved);
              if (
                path.isAbsolute(relative) ||
                relative === ".." ||
                relative.startsWith(`..${path.sep}`)
              ) {
                return yield* Effect.fail(
                  new BinaryRuntimeError({
                    path: candidate,
                    detail: `Extracted path resolves outside private staging: ${entry}`,
                  }),
                );
              }
            }
          });

        const extractRelease = (
          release: NativeReleaseArtifact,
          destination: string,
          platform: { readonly os: string; readonly arch: string },
        ) =>
          Effect.gen(function* () {
            const manifestResponse = yield* httpClient
              .get(release.manifestUrl)
              .pipe(
                Effect.catchTag("HttpClientError", (cause) =>
                  Effect.fail(new DownloadError({ url: release.manifestUrl, cause })),
                ),
              );
            const manifestText = yield* manifestResponse.text.pipe(
              Effect.catchTag("HttpClientError", (cause) =>
                Effect.fail(new DownloadError({ url: release.manifestUrl, cause })),
              ),
            );
            yield* Effect.try({
              try: () => {
                const parsed: unknown = JSON.parse(manifestText);
                return parsed;
              },
              catch: (cause) =>
                manifestError(release.manifestUrl, `Invalid JSON: ${String(cause)}`),
            }).pipe(Effect.flatMap((value) => validateManifest(release, value, platform, spawner)));

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

            const checksumResponse = yield* httpClient
              .get(release.checksumUrl)
              .pipe(
                Effect.catchTag("HttpClientError", (cause) =>
                  Effect.fail(new DownloadError({ url: release.checksumUrl, cause })),
                ),
              );
            const checksumText = yield* checksumResponse.text.pipe(
              Effect.catchTag("HttpClientError", (cause) =>
                Effect.fail(new DownloadError({ url: release.checksumUrl, cause })),
              ),
            );
            const expected = checksumForArchive(checksumText, `${release.assetName}.tar.zst`);
            if (expected === undefined) {
              return yield* Effect.fail(
                manifestError(release.checksumUrl, "SHA256SUMS has no entry for the archive"),
              );
            }
            yield* verifyChecksum(tarball, expected, release.checksumUrl);

            const archivePath = path.join(destination, `_download.${release.archive}`);
            yield* fs.writeFile(archivePath, new Uint8Array(tarball));

            const members = yield* spawner
              .string(ChildProcess.make("tar", ["--zstd", "-tf", archivePath]))
              .pipe(
                Effect.catch((cause) =>
                  Effect.fail(
                    new DownloadError({
                      url: release.downloadUrl,
                      cause,
                    }),
                  ),
                ),
              );
            const unsafeMember = members
              .split(/\r?\n/)
              .map((member) => member.trim())
              .find(isUnsafeArchiveMember);
            if (unsafeMember !== undefined) {
              return yield* Effect.fail(
                new DownloadError({
                  url: release.downloadUrl,
                  cause: new Error(`archive member is unsafe: ${unsafeMember}`),
                }),
              );
            }

            const [command, ...args] = extractCommand(archivePath, destination);
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

            yield* validateExtractedTree(destination);

            yield* fs.remove(archivePath).pipe(Effect.ignore);

            if (platform.os !== "win32") {
              yield* spawner
                .exitCode(ChildProcess.make("chmod", ["-R", "u+x", destination]))
                .pipe(Effect.ignore);
            }

            if (platform.os === "darwin") {
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

            const requiredPaths = [...new Set(release.requiredRuntimePaths)];
            const missing = yield* Effect.forEach(requiredPaths, (entry) =>
              fs.exists(path.join(destination, entry)),
            ).pipe(Effect.map((exists) => requiredPaths.filter((_entry, index) => !exists[index])));
            if (missing.length > 0) {
              return yield* Effect.fail(
                new BinaryRuntimeError({
                  path: destination,
                  detail: `Manifest runtime paths are missing: ${missing.join(", ")}`,
                }),
              );
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
              releaseSet: "slim-services",
              version: spec.version,
              runtime: "native",
              target: release.target,
            };
            const baseDir = spec.cacheDir ?? binDir;
            const cacheDir = cachePath(baseDir, info);
            const parentDir = path.dirname(cacheDir);
            const stagingPrefix = `.${release.assetName}.partial-`;
            yield* cleanupStaleStaging(parentDir, stagingPrefix);
            if (yield* isCompleteCache(cacheDir, release, info)) {
              return {
                path: cacheDir,
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
              yield* extractRelease(release, stagingDir, platform);
              yield* fs.writeFile(
                path.join(stagingDir, CACHE_COMPLETE_MARKER),
                new TextEncoder().encode(
                  JSON.stringify({
                    provider: release.provider,
                    service: spec.service,
                    version: spec.version,
                    asset: release.assetName,
                    url: release.downloadUrl,
                    target: info.target,
                    releaseSet: info.releaseSet,
                    runtime: info.runtime,
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
              if (yield* isCompleteCache(cacheDir, release, info)) {
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
              if (yield* isCompleteCache(cacheDir, release, info)) {
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
          plan,
          resolveWithMetadata,
          resolve: (spec: BinarySpec) => {
            return Effect.map(resolveWithMetadata(spec), ({ path }) => path);
          },
        };
      }),
    );
  }
}
