import * as nodePath from "node:path";

import type { CliConfig } from "@supabase/config";
import { Effect, FileSystem, Option, Path, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import {
  contentTypeForUpload,
  readSniffBytes,
  refineUploadContentType,
} from "../../../command-internal/storage-content-type.ts";
import {
  parseFileSizeLimit,
  resolveBucketProps,
} from "../../../command-internal/storage-bucket-config.ts";
import type { StorageGateway } from "../../../command-internal/storage-gateway.ts";
import {
  type StorageGatewayError,
  StorageGatewayStatusError,
} from "../../../command-internal/storage-gateway.errors.ts";
import {
  GoUrlParseError,
  STORAGE_SCHEME,
  goUrlParse,
  splitBucketPrefix,
} from "../../../command-internal/storage-url.ts";
import {
  assertStorageWorkdir,
  connectStorageGateway,
  loadStorageConfig,
} from "../storage.frame.ts";
import { StorageConfigError } from "../../../command-internal/storage-credentials.errors.ts";
import {
  StorageCopyBetweenBucketsError,
  StorageFileError,
  StorageMutuallyExclusiveFlagsError,
  StorageObjectNotFoundError,
  StorageUnsupportedOperationError,
  StorageUrlParseError,
} from "../storage.errors.ts";
import { iterateStoragePaths, iterateStoragePathsAll } from "../storage.iterate.ts";
import { resolveUploadDstPath } from "./cp.upload.ts";
import type { StorageCpFlags } from "./cp.command.ts";

interface CpSummary {
  readonly uploaded: Array<{ from: string; to: string }>;
  readonly downloaded: Array<{ from: string; to: string }>;
}

/**
 * `supabase storage cp <src> <dst>` — copy objects between local paths and
 * the Storage service. The scheme of `src`/`dst` selects the operation:
 * `ss://`→local download, local→`ss://` upload, both `ss://` → error, both
 * local → unsupported.
 */
export const storageCp = Effect.fn("storage.cp")(function* (flags: StorageCpFlags) {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const linkedProjectCache = yield* LinkedProjectCache;
  const resolver = yield* ProjectRefResolver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;

  const jobsFlag = Option.getOrElse(flags.jobs, () => 1);
  // A non-uint `--jobs` is already rejected in `cp.command.ts` with pflag's
  // uint parse error. The remaining clamp handles `--jobs 0` specifically: a
  // zero-sized job queue with an unbuffered channel and a zero-run priming
  // loop deadlocks the first Put. We clamp `0 → 1` to avoid that hang — do
  // not remove it.
  const jobs = jobsFlag < 1 ? 1 : jobsFlag;
  const contentTypeFlag = Option.getOrElse(flags.contentType, () => "");
  const cacheControlRaw = Option.getOrElse(flags.cacheControl, () => "max-age=3600");
  // An empty Cache-Control resets to the storage-js default.
  const cacheControl = cacheControlRaw.length === 0 ? "max-age=3600" : cacheControlRaw;

  let linkedRef = "";

  yield* Effect.gen(function* () {
    yield* assertStorageWorkdir(cliSettings.workdir);

    // `--project-ref` never implies `--linked` and must not be silently
    // discarded on the local target — see push.handler.ts's identical guard
    // (db push) for the full TS-only rationale.
    if (Option.isSome(flags.projectRef) && flags.local) {
      return yield* Effect.fail(
        new StorageMutuallyExclusiveFlagsError({
          message:
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local)",
        }),
      );
    }

    const projectRef = flags.local ? "" : yield* resolver.loadProjectRef(flags.projectRef);
    linkedRef = projectRef;
    const loaded = yield* loadStorageConfig(cliSettings, projectRef);
    if (loaded.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr");
    }

    // Parse both URLs leniently (NOT the strict storage-URL parser), BEFORE
    // building the client — an invalid url fails without an api-keys lookup.
    const srcUrl = yield* parseCpUrl(flags.src, "src");
    const dstUrl = yield* parseCpUrl(flags.dst, "dst");
    const srcIsStorage = srcUrl.scheme === STORAGE_SCHEME;
    const dstIsStorage = dstUrl.scheme === STORAGE_SCHEME;

    const summary: CpSummary = { uploaded: [], downloaded: [] };

    yield* connectStorageGateway(
      { projectRef, config: loaded.config, userAgent: cliSettings.userAgent },
      (gateway) =>
        Effect.gen(function* () {
          if (srcIsStorage && dstUrl.scheme === "") {
            const localPath = absLocal(path, runtimeInfo.cwd, flags.dst);
            if (flags.recursive) {
              yield* downloadAll(gateway, output, fs, path, srcUrl.path, localPath, jobs, summary);
            } else {
              yield* downloadSingle(gateway, fs, srcUrl.path, localPath, summary);
            }
          } else if (srcUrl.scheme === "" && dstIsStorage) {
            const localPath = absLocal(path, runtimeInfo.cwd, flags.src);
            const uploadCtx = {
              gateway,
              output,
              fs,
              path,
              contentTypeFlag,
              cacheControl,
              config: loaded.config,
              document: loaded.document,
              summary,
            };
            if (flags.recursive) {
              yield* uploadAll(uploadCtx, dstUrl.path, localPath, jobs);
            } else {
              yield* uploadSingle(uploadCtx, dstUrl.path, localPath);
            }
          } else if (srcIsStorage && dstIsStorage) {
            return yield* new StorageCopyBetweenBucketsError();
          } else {
            return yield* new StorageUnsupportedOperationError();
          }

          if (output.format !== "text") {
            yield* output.success("", {
              uploaded: summary.uploaded,
              downloaded: summary.downloaded,
            });
          }
        }),
    );
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() => (linkedRef === "" ? Effect.void : linkedProjectCache.cache(linkedRef))),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});

const parseCpUrl = (raw: string, which: "src" | "dst") =>
  Effect.try({
    try: () => goUrlParse(raw),
    catch: (cause) =>
      new StorageUrlParseError({
        message: `failed to parse ${which} url: ${
          cause instanceof GoUrlParseError ? cause.message : String(cause)
        }`,
      }),
  });

/** Resolve a local path against the original cwd. */
function absLocal(path: Path.Path, cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

/** Write a stream chunk fully to the open file handle. */
const writeChunk = (handle: FileSystem.File, chunk: Uint8Array) => handle.writeAll(chunk);

// Download (remote → local)

/** Go `api.DownloadObject` (`objects.go:135-142`): O_EXCL create, then stream. */
const downloadSingle = (
  gateway: StorageGateway,
  fs: FileSystem.FileSystem,
  remotePath: string,
  localPath: string,
  summary: CpSummary,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(localPath, { flag: "wx" }).pipe(
        Effect.mapError(
          (cause) =>
            new StorageFileError({
              message: `failed to create file: ${String(cause.cause ?? cause)}`,
            }),
        ),
      );
      yield* gateway
        .downloadObject(remotePath)
        .pipe(Stream.runForEach((c) => writeChunk(handle, c)));
      summary.downloaded.push({ from: remotePath, to: localPath });
    }),
  );

/** Go `DownloadStorageObjectAll` (`cp.go:63-97`): BFS, O_TRUNC, mkdir parents. */
const downloadAll = (
  gateway: StorageGateway,
  output: typeof Output.Service,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  remotePath: string,
  localPath0: string,
  jobs: number,
  summary: CpSummary,
) =>
  Effect.gen(function* () {
    // If the destination is an existing directory, nest under base(remotePath).
    const isDir = yield* fs.stat(localPath0).pipe(
      Effect.map((i) => i.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
    const localPath = isDir
      ? path.join(localPath0, nodePath.posix.basename(remotePath))
      : localPath0;

    const tasks: Array<{ objectPath: string; dstPath: string; isDir: boolean }> = [];
    // Capture the walk error as a value rather than failing on it immediately:
    // Go returns `errors.Join(walkErr, jq.Collect())` (`cp.go:96`), so two
    // ordering rules hold. (1) The `count == 0 → "Object not found"` check
    // precedes the join (`cp.go:93-95`), masking a walk error when nothing was
    // visited. (2) A walk that errors partway still runs the already-queued
    // downloads before the walk error surfaces — so the check is sequenced after
    // the download pass below, not before it.
    const iterError = yield* iterateStoragePathsAll(gateway, output, remotePath, (objectPath) =>
      Effect.gen(function* () {
        const relPath = objectPath.startsWith(remotePath)
          ? objectPath.slice(remotePath.length)
          : objectPath;
        const dstPath = path.join(localPath, relPath);
        yield* output.raw(`Downloading: ${objectPath} => ${dstPath}\n`, "stderr");
        tasks.push({ objectPath, dstPath, isDir: objectPath.endsWith("/") });
      }),
    ).pipe(
      Effect.as<StorageGatewayError | undefined>(undefined),
      Effect.catch((error) => Effect.succeed(error)),
    );

    if (tasks.length === 0) {
      return yield* new StorageObjectNotFoundError(remotePath);
    }

    yield* Effect.forEach(
      tasks,
      (task) =>
        task.isDir
          ? makeDirIfNotExist(fs, task.dstPath)
          : Effect.gen(function* () {
              yield* makeDirIfNotExist(fs, path.dirname(task.dstPath));
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const handle = yield* fs.open(task.dstPath, { flag: "w" }).pipe(
                    Effect.mapError(
                      (cause) =>
                        new StorageFileError({
                          message: `failed to create file: ${String(cause.cause ?? cause)}`,
                        }),
                    ),
                  );
                  yield* gateway
                    .downloadObject(task.objectPath)
                    .pipe(Stream.runForEach((c) => writeChunk(handle, c)));
                }),
              );
              summary.downloaded.push({ from: task.objectPath, to: task.dstPath });
            }),
      { concurrency: jobs },
    );

    // Surface the walk error only after the queued downloads have run, matching
    // `errors.Join(walkErr, jq.Collect())`. A download failure propagates from
    // the pass above (the job queue's first error); the rare walk-error +
    // download-error pair is collapsed to whichever fails first.
    if (iterError !== undefined) {
      return yield* Effect.fail(iterError);
    }
  });

const makeDirIfNotExist = (fs: FileSystem.FileSystem, dir: string) =>
  fs.makeDirectory(dir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new StorageFileError({
          message: `failed to mkdir: ${String(cause.cause ?? cause)}`,
        }),
    ),
  );

// Upload (local → remote)

interface UploadCtx {
  readonly gateway: StorageGateway;
  readonly output: typeof Output.Service;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly contentTypeFlag: string;
  readonly cacheControl: string;
  readonly config: CliConfig;
  readonly document: Record<string, unknown> | undefined;
  readonly summary: CpSummary;
}

const resolveContentType = (ctx: UploadCtx, filePath: string) =>
  Effect.gen(function* () {
    if (ctx.contentTypeFlag.length > 0) {
      return refineUploadContentType(ctx.contentTypeFlag, filePath);
    }
    const sniff = yield* readSniffBytes(ctx.fs, filePath);
    return contentTypeForUpload(sniff, filePath);
  });

/** Go `api.UploadObject` single (`cp.go:55`): no x-upsert, no "Uploading:" line. */
const uploadSingle = (ctx: UploadCtx, remoteDstPath: string, localPath: string) =>
  Effect.gen(function* () {
    const contentType = yield* resolveContentType(ctx, localPath);
    yield* ctx.gateway.uploadObject(remoteDstPath, localPath, {
      contentType,
      cacheControl: ctx.cacheControl,
      overwrite: false,
    });
    ctx.summary.uploaded.push({ from: localPath, to: remoteDstPath });
  });

/** Go `UploadStorageObjectAll` (`cp.go:99-172`): walk + dst-key + auto-create. */
const uploadAll = (ctx: UploadCtx, remotePath: string, localPath: string, jobs: number) =>
  Effect.gen(function* () {
    const noSlash = remotePath.endsWith("/") ? remotePath.slice(0, -1) : remotePath;

    // Detect whether base(noSlash) already exists remotely as a file or dir.
    let dirExists = false;
    let fileExists = false;
    if (noSlash.length > 0) {
      const base = nodePath.posix.basename(noSlash);
      yield* iterateStoragePaths(ctx.gateway, ctx.output, noSlash, (objectName) =>
        Effect.sync(() => {
          if (objectName === base) fileExists = true;
          if (objectName === `${base}/`) dirExists = true;
        }),
      );
    }

    const baseName = ctx.path.basename(localPath);
    const files = yield* collectUploadFiles(ctx.fs, ctx.path, localPath);

    const tasks: Array<{ filePath: string; dstPath: string }> = [];
    for (const file of files) {
      const dstPath = resolveUploadDstPath({
        remotePath,
        relPath: file.relPath,
        fileName: ctx.path.basename(file.filePath),
        baseName,
        noSlash,
        dirExists,
        fileExists,
      });
      yield* ctx.output.raw(`Uploading: ${file.filePath} => ${dstPath}\n`, "stderr");
      tasks.push({ filePath: file.filePath, dstPath });
    }

    yield* Effect.forEach(
      tasks,
      (task) => uploadOneWithAutoCreate(ctx, task.dstPath, task.filePath),
      {
        concurrency: jobs,
      },
    );
  });

/** One recursive upload (overwrite), retrying after bucket auto-create on 404. */
const uploadOneWithAutoCreate = (ctx: UploadCtx, dstPath: string, filePath: string) =>
  Effect.gen(function* () {
    const contentType = yield* resolveContentType(ctx, filePath);
    const upload = ctx.gateway.uploadObject(dstPath, filePath, {
      contentType,
      cacheControl: ctx.cacheControl,
      overwrite: true,
    });
    yield* upload.pipe(
      Effect.catch((error) =>
        error instanceof StorageGatewayStatusError &&
        error.body.includes('"error":"Bucket not found"')
          ? autoCreateAndRetry(ctx, dstPath, upload, error)
          : Effect.fail(error),
      ),
    );
    ctx.summary.uploaded.push({ from: filePath, to: dstPath });
  });

const autoCreateAndRetry = (
  ctx: UploadCtx,
  dstPath: string,
  retry: Effect.Effect<void, StorageGatewayError>,
  original: StorageGatewayStatusError,
) =>
  Effect.gen(function* () {
    const [bucket, prefix] = splitBucketPrefix(dstPath);
    // Go only auto-creates when a prefix follows the bucket (`cp.go:154`).
    if (prefix.length === 0) {
      return yield* Effect.fail(original);
    }
    const props = yield* bucketAutoCreateProps(ctx, bucket);
    yield* ctx.gateway.createBucket(bucket, props);
    yield* retry;
  });

/** Props for an auto-created bucket: from `[storage.buckets.<name>]` if present. */
const bucketAutoCreateProps = (ctx: UploadCtx, bucket: string) =>
  Effect.gen(function* () {
    const bucketConfig = ctx.config.storage.buckets?.[bucket];
    if (bucketConfig === undefined) {
      return { public: undefined, fileSizeLimit: 0, allowedMimeTypes: [] };
    }
    return yield* Effect.try({
      try: () =>
        resolveBucketProps({
          document: ctx.document,
          name: bucket,
          bucket: bucketConfig,
          storageFileSizeLimitBytes: parseFileSizeLimit(ctx.config.storage.file_size_limit),
        }),
      catch: (cause) =>
        new StorageConfigError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
  });

interface UploadFile {
  readonly filePath: string;
  readonly relPath: string;
}

/**
 * Lexically-ordered regular files under `root`: directories are descended,
 * symlinks and other non-regular files are skipped. A single-file root
 * yields one entry with `relPath === "."`.
 */
const collectUploadFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
): Effect.Effect<ReadonlyArray<UploadFile>, PlatformError> =>
  Effect.gen(function* () {
    const info = yield* fs.stat(root);
    if (info.type === "File") {
      return [{ filePath: root, relPath: "." }];
    }
    if (info.type === "Directory") {
      const out: Array<UploadFile> = [];
      yield* walkUploadDir(fs, path, root, root, out);
      return out;
    }
    return [];
  });

const walkUploadDir = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  dir: string,
  out: Array<UploadFile>,
): Effect.Effect<void, PlatformError> =>
  Effect.gen(function* () {
    const names = [...(yield* fs.readDirectory(dir))].sort();
    for (const name of names) {
      const abs = path.join(dir, name);
      // afero.Walk uses Lstat (no-follow); a symlink is not regular → skipped.
      const isSymlink = yield* fs.readLink(abs).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (isSymlink) continue;
      const info = yield* fs.stat(abs);
      if (info.type === "Directory") {
        yield* walkUploadDir(fs, path, root, abs, out);
      } else if (info.type === "File") {
        out.push({ filePath: abs, relPath: path.relative(root, abs) });
      }
    }
  });
