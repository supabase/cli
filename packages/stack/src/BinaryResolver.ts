import { createHash, randomUUID } from "node:crypto";
import { Effect, FileSystem, Layer, Path, Context, Option, PlatformError } from "effect";
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

/**
 * Written as the last step of staging, so its presence in `cacheDir` after
 * the atomic rename is a version-agnostic signal that the entry is a
 * complete, valid cache hit — not just non-empty. A `cacheDir` that exists
 * but lacks this marker can only be a broken leftover from an older,
 * pre-atomic-rename CLI version that wrote directly into `cacheDir` and
 * could be killed mid-extraction.
 */
const CACHE_COMPLETE_MARKER = ".supabase-cache-complete";

/**
 * The file each service's runner actually executes from a resolved directory
 * (see `services/*.ts`). A markerless legacy cache entry is only trusted as a
 * download-failure fallback when this file is present — mere non-emptiness
 * would also accept a partial leftover from a killed pre-staging writer, and
 * "resolving" one of those masks the DownloadError that lets the stack fall
 * back to a Docker image instead of exec-ing a missing binary.
 */
const SERVICE_ENTRYPOINT: Partial<Record<BinarySpec["service"], string>> = {
  postgres: "share/supabase-cli/bin/supabase-postgres-init.sh",
  postgrest: "postgrest",
  auth: "auth",
  "edge-runtime": "bin/edge-runtime",
};

/**
 * Age threshold for reaping abandoned `.tmp-*` staging siblings (see the
 * sweep in `resolveWithMetadata`). Generous on purpose: well beyond how long
 * any of these downloads/extracts should realistically take, so it can
 * never step on a genuinely live concurrent download.
 */
const STALE_TMP_DIR_AGE_MS = 24 * 60 * 60 * 1000;

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
  static CACHE_COMPLETE_MARKER = CACHE_COMPLETE_MARKER;

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

            // Opportunistically reap staging directories abandoned by a
            // prior invocation that was killed (SIGKILL/OOM) between
            // creating its tmpDir and the atomic rename — Effect.ensuring
            // can't run past a hard process kill, and every attempt mints a
            // fresh UUID, so nothing else ever revisits these siblings
            // otherwise. Runs unconditionally, before the cache-hit check
            // below: once cacheDir becomes a complete cache hit, every
            // future resolve for this spec would otherwise return early and
            // never reach a sweep placed after that check, for the rest of
            // that cache entry's lifetime. Scoped to just this cacheDir's
            // own tmp-* siblings (not a general cache-root scan), gated by a
            // generous age threshold, and entirely best-effort.
            const tmpDirPrefix = `${path.basename(cacheDir)}.tmp-`;
            const parentDir = path.dirname(cacheDir);
            yield* fs.readDirectory(parentDir).pipe(
              Effect.flatMap((siblings) =>
                Effect.forEach(
                  siblings.filter((name) => name.startsWith(tmpDirPrefix)),
                  (name) => {
                    const staleDir = path.join(parentDir, name);
                    return fs.stat(staleDir).pipe(
                      Effect.flatMap((info) =>
                        Option.match(info.mtime, {
                          onNone: () => Effect.void,
                          onSome: (mtime) =>
                            Date.now() - mtime.getTime() > STALE_TMP_DIR_AGE_MS
                              ? fs.remove(staleDir, { recursive: true, force: true })
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

            // Check if already cached. The final cacheDir is only ever
            // populated by an atomic rename of a fully-staged directory
            // carrying a completion marker (see below), so we check for that
            // marker rather than mere non-emptiness — a cacheDir that exists
            // but lacks it can only be a broken leftover (e.g. from an older,
            // pre-staging CLI version). We deliberately do NOT remove it
            // here: every cache entry written before this marker existed is
            // markerless, so eagerly deleting it before we've even attempted
            // a download would destroy a plausibly-still-usable legacy
            // binary before knowing whether we can replace it (e.g. an
            // offline invocation or a GitHub outage would previously have
            // succeeded from that cache; deleting it upfront turns that into
            // a hard failure with no cache left afterward either). It's left
            // in place and only ever reclaimed later, in the publish step
            // below, once a fully-staged replacement is ready to atomically
            // take its place.
            const isComplete = yield* fs.exists(path.join(cacheDir, CACHE_COMPLETE_MARKER));
            if (isComplete) {
              return {
                path: cacheDir,
                downloaded: false,
              } satisfies ResolveBinaryResult;
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

              // Write the completion marker last, so it's carried into
              // cacheDir by the same atomic rename as the rest of the
              // payload — its presence is the version-agnostic completeness
              // signal the cache-hit and lost-race checks rely on.
              yield* fs.writeFile(path.join(tmpDir, CACHE_COMPLETE_MARKER), new Uint8Array());
            });

            // Publish the completed staging directory by atomically renaming
            // it into place. If another process already published a
            // complete cacheDir first (verified via the completion marker,
            // not mere existence), discard our own copy and resolve to
            // theirs instead of failing. If cacheDir exists but isn't a
            // complete, marker-carrying entry — a broken/incomplete leftover
            // from an older, pre-staging CLI version (see the comment above
            // the marker check: this is the only place such a leftover is
            // ever removed), or the rename failed for some unrelated reason
            // — our own staged build is the only known-good copy: reclaim
            // the spot and retry the rename, up to MAX_RECLAIM_ATTEMPTS
            // times. A legitimate winner can also land in the narrow gap
            // between the marker check and our own reclaim-and-retry (e.g. a
            // third resolver, or a legacy writer); attemptPublish always
            // re-checks the marker on every attempt (including the last) and
            // adopts a winner immediately if one appears, regardless of how
            // many reclaim attempts remain. Only the destructive
            // reclaim-and-retry path is bounded — a rename that keeps
            // failing for a reason unrelated to a competing destination
            // (permissions, a read-only filesystem, disk I/O) can never
            // succeed no matter how many times we retry, so once attempts
            // are exhausted we surface the real rename error instead of
            // retrying forever. The mirror case — clobbering a destination
            // published in the sliver of time between the marker check and
            // our `fs.remove` — is an accepted, narrow residual limitation:
            // fully closing it needs real cross-process locking, which is
            // disproportionate here since the outcome is bounded to a
            // redundant rebuild of the same spec, not data loss. The whole
            // stage-and-publish lifecycle is wrapped in a single
            // `Effect.ensuring(cleanupTmpDir)` finalizer so every exit —
            // stage failure, a genuine rename failure, or an interruption at
            // any point — removes the staging directory. `cleanupTmpDir`
            // force-removes and ignores errors, so it's a safe no-op once
            // the rename has already moved tmpDir into place.
            const MAX_RECLAIM_ATTEMPTS = 3;

            const published = yield* Effect.gen(function* () {
              yield* stage;

              const renameOnce = () => fs.rename(tmpDir, cacheDir).pipe(Effect.as(true));

              const attemptPublish = (
                attemptsRemaining = MAX_RECLAIM_ATTEMPTS,
              ): Effect.Effect<boolean, PlatformError.PlatformError> =>
                renameOnce().pipe(
                  Effect.catchTag("PlatformError", (renameError) =>
                    fs.exists(path.join(cacheDir, CACHE_COMPLETE_MARKER)).pipe(
                      Effect.flatMap((legitimateWinner) => {
                        if (legitimateWinner) return Effect.succeed(false);
                        if (attemptsRemaining <= 0) return Effect.fail(renameError);
                        return fs
                          .remove(cacheDir, { recursive: true, force: true })
                          .pipe(
                            Effect.ignore,
                            Effect.andThen(attemptPublish(attemptsRemaining - 1)),
                          );
                      }),
                    ),
                  ),
                );

              return yield* attemptPublish();
            }).pipe(
              Effect.ensuring(cleanupTmpDir),
              // A cache entry written by a pre-marker CLI release is non-empty
              // but markerless, so it fails the completeness check above and
              // lands here to be replaced. When the replacement cannot be
              // fetched (offline, GitHub outage), that previously-working
              // binary is strictly better than a hard failure — the same
              // trade every pre-marker release already made on every resolve.
              Effect.catchTag("DownloadError", (error) => {
                const entrypoint = SERVICE_ENTRYPOINT[spec.service];
                if (entrypoint === undefined) return Effect.fail(error);
                return fs.exists(path.join(cacheDir, entrypoint)).pipe(
                  Effect.mapError(() => error),
                  Effect.flatMap((usable) => (usable ? Effect.succeed(false) : Effect.fail(error))),
                );
              }),
            );

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
