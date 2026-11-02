import {
  Clock,
  Crypto,
  Effect,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Predicate,
  Scope,
} from "effect";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { ArtifactIntegrityError, PreparationError } from "./Errors.ts";
import { validateRelativePath, validateSha256 } from "./Integrity.ts";
import { restrictDirectoryToOwner } from "../runtime/postgres-user.ts";
import { fsyncDirectory } from "../namespace/drivers/FileSystem.ts";
import {
  acquireLock,
  isMissing,
  takeExclusiveLock,
  takeLock,
} from "../namespace/drivers/Sqlite.ts";
import * as Pin from "../namespace/Pin.ts";

/** A concrete artifact identity. `key` may contain subdirectories but never an absolute or traversing path. */
export interface ArtifactRequest {
  /** Immutable published identity; a reused key reuses its persisted digest. */
  readonly key: string;
  /** Relative paths that a runtime may use after installation. */
  readonly requiredRuntimePaths: ReadonlyArray<string>;
  /** The relative executable path, if this artifact starts a native workload. */
  readonly executablePath?: string;
}

/**
 * The source is the only download/archive boundary: it writes an unpacked artifact tree
 * below `destination` after verifying the downloaded archive digest. HTTP transport remains
 * supplied by the caller through the Effect HttpClient service.
 */
export interface ArtifactSource {
  /** Resolves the published digest only when the store has no valid cached artifact. */
  readonly checksum: (
    request: ArtifactRequest,
  ) => Effect.Effect<string, PreparationError, HttpClient.HttpClient>;
  readonly materialize: (
    request: ArtifactRequest,
    destination: string,
    expectedSha256: string,
    onProgress?: (state: "downloading" | "preparing") => void,
  ) => Effect.Effect<
    void,
    PreparationError | ArtifactIntegrityError,
    | FileSystem.FileSystem
    | Path.Path
    | Crypto.Crypto
    | ChildProcessSpawner.ChildProcessSpawner
    | HttpClient.HttpClient
  >;
}

export interface ArtifactStoreOptions {
  readonly cacheRoot: string;
  readonly source: ArtifactSource;
}

export interface PreparedArtifact {
  readonly key: string;
  /** Installed, content-addressed generation directory. Required runtime paths are relative to it. */
  readonly path: string;
  /** The generation's digest lock file; pinned by `use` for the life of its returned scope. */
  readonly lockPath: string;
  readonly sha256: string;
  readonly requiredRuntimePaths: ReadonlyArray<string>;
  readonly executablePath?: string;
  readonly outcome: "cached" | "downloaded";
}

type ArtifactStoreError = PreparationError | ArtifactIntegrityError;

/** Child of a staging directory that sources materialize into, renamed whole to publish. */
const STAGING_CONTENT_NAME = "content";
/** Per-key directory holding every in-progress preparer's and retirer's staging slot. */
const STAGING_DIR_NAME = ".staging";
const DIRECTORY_MODE = 0o755;
/** A generation is eligible for retirement once its digest lock file's mtime is this old. */
const RETIREMENT_AGE_MILLIS = 30 * 24 * 60 * 60 * 1000;
const DIGEST_NAME = /^[0-9a-f]{64}$/u;

type ArtifactPathKind = "file" | "directory" | "symlink";

type InspectedArtifactPath = {
  readonly kind: ArtifactPathKind;
  readonly realPath: string;
  readonly linkText?: string;
};

const artifactError = (message: string, fields: Readonly<Record<string, unknown>> = {}) =>
  new PreparationError({ ...fields, message });

const metadataError = (message: string, fields: Readonly<Record<string, unknown>> = {}) =>
  new ArtifactIntegrityError({ ...fields, message });

const mapFs = <A>(
  path: string,
  operation: string,
  effect: Effect.Effect<A, PlatformError.PlatformError>,
): Effect.Effect<A, PreparationError> =>
  effect.pipe(
    Effect.mapError((cause) =>
      artifactError(
        `Unable to ${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          path,
          cause,
        },
      ),
    ),
  );

const pathWithin = (root: string, candidate: string, separator: string): boolean =>
  candidate !== root && candidate.startsWith(`${root}${separator}`);

const pathAtOrBelow = (root: string, candidate: string, separator: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${separator}`);

const isNotFound = (cause: unknown): cause is PlatformError.PlatformError =>
  cause instanceof PlatformError.PlatformError &&
  cause.reason instanceof PlatformError.SystemError &&
  Predicate.isTagged(cause.reason, "NotFound");

const isMissingArtifactRoot = (error: ArtifactIntegrityError): boolean =>
  Predicate.hasProperty(error, "cause") && isNotFound(error.cause);

const validateKey = (key: string): Effect.Effect<void, PreparationError> =>
  validateRelativePath(key, "artifact key").pipe(
    Effect.flatMap(() =>
      /^[A-Za-z0-9][A-Za-z0-9._-]*(?:[\\/][A-Za-z0-9][A-Za-z0-9._-]*)*$/u.test(key)
        ? Effect.void
        : Effect.fail(artifactError("Artifact key contains unsupported characters", { key })),
    ),
  );

const validateRequest = (request: ArtifactRequest): Effect.Effect<void, PreparationError> =>
  Effect.gen(function* () {
    yield* validateKey(request.key);
    const seen = new Set<string>();
    for (const relative of request.requiredRuntimePaths) {
      yield* validateRelativePath(relative, "required runtime path");
      if (seen.has(relative))
        return yield* artifactError("Duplicate required runtime path", { path: relative });
      seen.add(relative);
    }
    if (request.executablePath !== undefined) {
      yield* validateRelativePath(request.executablePath, "executable path");
      if (!seen.has(request.executablePath))
        return yield* artifactError("Executable path must be required", {
          path: request.executablePath,
        });
    }
  });

/**
 * Creates `directory` (and any missing ancestors up to `canonicalRoot`) and restricts every
 * segment along the way to its owner, preserving a traverse-only grant: every container level
 * under the cache root, not just the leaf, must stay owner-restricted as the tree grows.
 */
const ensureDirectory = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
  canonicalRoot: string,
): Effect.Effect<void, PreparationError> =>
  Effect.gen(function* () {
    const root = path.resolve(canonicalRoot);
    const resolved = path.resolve(directory);
    if (!pathAtOrBelow(root, resolved, path.sep))
      return yield* artifactError("Artifact directory escapes cache root", { path: directory });
    const relative = path.relative(root, resolved);
    let current = root;
    for (const segment of relative.split(path.sep).filter((value) => value.length > 0)) {
      current = path.join(current, segment);
      const exists = yield* mapFs(current, "inspect artifact directory", fs.exists(current));
      if (!exists)
        // `recursive: true` tolerates a concurrent preparer that just created this very segment
        // between the `exists` check above and this call; it is otherwise a single-directory make.
        yield* mapFs(
          current,
          "create artifact directory",
          fs.makeDirectory(current, { recursive: true, mode: 0o700 }),
        );
      const real = yield* fs.realPath(current).pipe(
        Effect.mapError((cause) =>
          artifactError(`Unable to resolve artifact directory: ${cause.message}`, {
            path: current,
            cause,
          }),
        ),
      );
      if (real !== current)
        return yield* artifactError("Artifact directory contains a symlink", { path: current });
      if (!pathAtOrBelow(root, real, path.sep))
        return yield* artifactError("Artifact directory escapes cache root", { path: current });
      yield* mapFs(current, "secure artifact directory", restrictDirectoryToOwner(fs, current));
    }
  });

const ensureSafeRoot = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  canonicalRoot: string,
): Effect.Effect<string, ArtifactIntegrityError> =>
  Effect.gen(function* () {
    const resolvedRoot = path.resolve(root);
    const rootInfo = yield* fs
      .stat(root)
      .pipe(
        Effect.mapError((cause) =>
          metadataError("Cached artifact root cannot be inspected", { root, cause }),
        ),
      );
    if (rootInfo.type !== "Directory")
      return yield* metadataError("Cached artifact root must be a directory", { root });
    const realRoot = yield* fs
      .realPath(root)
      .pipe(
        Effect.mapError((cause) =>
          metadataError("Cached artifact root cannot be resolved", { root, cause }),
        ),
      );
    if (realRoot !== resolvedRoot)
      return yield* metadataError("Cached artifact root contains a symlink", { root });
    if (!pathAtOrBelow(path.resolve(canonicalRoot), realRoot, path.sep))
      return yield* metadataError("Cached artifact root escapes cache root", { root });
    return realRoot;
  });

const hasErrnoCode = (value: unknown): value is { readonly code?: unknown } =>
  typeof value === "object" && value !== null && "code" in value;

const isReadLinkNonSymlink = (cause: PlatformError.PlatformError): boolean =>
  cause instanceof PlatformError.PlatformError &&
  cause.reason instanceof PlatformError.SystemError &&
  cause.reason.method === "readLink" &&
  hasErrnoCode(cause.reason.cause) &&
  cause.reason.cause.code === "EINVAL";

const inspectBasicKind = (
  fs: FileSystem.FileSystem,
  candidate: string,
): Effect.Effect<InspectedArtifactPath, ArtifactIntegrityError> =>
  fs.readLink(candidate).pipe(
    Effect.map((linkText): InspectedArtifactPath => ({
      kind: "symlink",
      realPath: candidate,
      linkText,
    })),
    Effect.catch((cause): Effect.Effect<InspectedArtifactPath, ArtifactIntegrityError> => {
      if (!isReadLinkNonSymlink(cause))
        return Effect.fail(
          metadataError("Unable to inspect required runtime path", { path: candidate, cause }),
        );
      return fs.stat(candidate).pipe(
        Effect.mapError((statCause) =>
          metadataError("Unable to inspect required runtime path", {
            path: candidate,
            cause: statCause,
          }),
        ),
        Effect.flatMap((info) => {
          if (info.type === "File")
            return Effect.succeed<InspectedArtifactPath>({ kind: "file", realPath: candidate });
          if (info.type === "Directory")
            return Effect.succeed<InspectedArtifactPath>({
              kind: "directory",
              realPath: candidate,
            });
          return Effect.fail(
            metadataError("Required runtime path must be a file or directory", {
              path: candidate,
              type: info.type,
            }),
          );
        }),
      );
    }),
  );

const resolveContainedPath = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  candidate: string,
  realRoot: string,
): Effect.Effect<string, ArtifactIntegrityError> =>
  fs.realPath(candidate).pipe(
    Effect.mapError((cause) =>
      metadataError("Required runtime path cannot be resolved", { path: candidate, cause }),
    ),
    Effect.flatMap((realCandidate) =>
      pathAtOrBelow(realRoot, realCandidate, path.sep)
        ? Effect.succeed(realCandidate)
        : Effect.fail(
            metadataError("Required runtime path escapes its installation directory", {
              path: candidate,
            }),
          ),
    ),
  );

const ensureSymlinkTargetShape = (
  fs: FileSystem.FileSystem,
  realPath: string,
): Effect.Effect<void, ArtifactIntegrityError> =>
  fs.stat(realPath).pipe(
    Effect.mapError((cause) =>
      metadataError("Unable to inspect required runtime path target", { path: realPath, cause }),
    ),
    Effect.flatMap((info) =>
      info.type === "File" || info.type === "Directory"
        ? Effect.void
        : Effect.fail(
            metadataError("Required runtime path must resolve to a file or directory", {
              path: realPath,
              type: info.type,
            }),
          ),
    ),
  );

const inspectFreshPath = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  candidate: string,
  realRoot: string,
): Effect.Effect<InspectedArtifactPath, ArtifactIntegrityError> =>
  Effect.gen(function* () {
    const inspected = yield* inspectBasicKind(fs, candidate);
    const realPath = yield* resolveContainedPath(fs, path, candidate, realRoot);
    if (inspected.kind === "symlink") {
      yield* ensureSymlinkTargetShape(fs, realPath);
      const linkText = yield* fs.readLink(candidate).pipe(
        Effect.mapError((cause) =>
          metadataError("Required runtime path symlink changed during validation", {
            path: candidate,
            cause,
          }),
        ),
      );
      if (linkText !== inspected.linkText)
        return yield* metadataError("Required runtime path symlink changed during validation", {
          path: candidate,
        });
    }
    return { ...inspected, realPath };
  });

const validateFreshRuntimePaths = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  realRoot: string,
  relativePaths: ReadonlyArray<string>,
): Effect.Effect<Readonly<Record<string, InspectedArtifactPath>>, ArtifactIntegrityError> =>
  Effect.gen(function* () {
    const inspectDirectory = (relative: string) =>
      Effect.gen(function* () {
        const candidate = path.resolve(root, relative);
        const inspected = yield* inspectFreshPath(fs, path, candidate, realRoot);
        const traversable =
          inspected.kind === "directory" ||
          (inspected.kind === "symlink" &&
            (yield* fs.stat(inspected.realPath).pipe(
              Effect.mapError((cause) =>
                metadataError("Unable to inspect required runtime path target", {
                  path: inspected.realPath,
                  cause,
                }),
              ),
              Effect.map((info) => info.type === "Directory"),
            )));
        if (traversable) {
          const children = yield* fs.readDirectory(candidate, { recursive: true }).pipe(
            Effect.mapError((cause) =>
              metadataError("Unable to inspect required runtime directory", {
                path: candidate,
                cause,
              }),
            ),
          );
          for (const child of children.sort()) {
            yield* inspectFreshPath(fs, path, path.join(inspected.realPath, child), realRoot);
          }
        }
        return [relative, inspected] as const;
      });
    const entries = yield* Effect.forEach(relativePaths, inspectDirectory);
    return Object.fromEntries(entries);
  });

/** Shallow containment+kind check for an already-published, trusted generation: no recursion. */
const inspectRequiredPaths = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  realRoot: string,
  relativePaths: ReadonlyArray<string>,
): Effect.Effect<Readonly<Record<string, InspectedArtifactPath>>, ArtifactIntegrityError> =>
  Effect.gen(function* () {
    const entries: Array<readonly [string, InspectedArtifactPath]> = [];
    for (const relative of relativePaths) {
      const candidate = path.resolve(root, relative);
      if (!pathWithin(path.resolve(root), candidate, path.sep))
        return yield* metadataError("Artifact path escapes its installation directory", {
          path: relative,
        });
      const exists = yield* fs
        .exists(candidate)
        .pipe(
          Effect.mapError((cause) =>
            metadataError("Unable to inspect cached artifact path", { path: candidate, cause }),
          ),
        );
      if (!exists)
        return yield* metadataError(
          `Cached artifact is missing ${candidate}; remove ${root} to reinstall it`,
          { path: relative },
        );
      const inspected = yield* inspectFreshPath(fs, path, candidate, realRoot);
      entries.push([relative, inspected]);
    }
    return Object.fromEntries(entries);
  });

/** Kind-only executable check, used before a fresh publish normalizes its final mode. */
const ensureExecutableFile = (
  fs: FileSystem.FileSystem,
  executable: string,
): Effect.Effect<void, ArtifactIntegrityError> =>
  fs.stat(executable).pipe(
    Effect.mapError((cause) =>
      metadataError("Cached artifact executable cannot be inspected", {
        path: executable,
        cause,
      }),
    ),
    Effect.flatMap((info) =>
      info.type === "File"
        ? Effect.void
        : Effect.fail(
            metadataError("Artifact executable path must resolve to a regular file", {
              path: executable,
              type: info.type,
            }),
          ),
    ),
  );

/** A published generation is never chmodded again, so a cache hit must check the bit directly. */
const ensureExecutableMode = (
  fs: FileSystem.FileSystem,
  generation: string,
  executable: string,
): Effect.Effect<void, ArtifactIntegrityError> =>
  fs.stat(executable).pipe(
    Effect.mapError((cause) =>
      metadataError("Cached artifact executable cannot be inspected", {
        path: executable,
        cause,
      }),
    ),
    Effect.flatMap((info) =>
      (info.mode & 0o100) !== 0
        ? Effect.void
        : Effect.fail(
            metadataError(
              `Cached artifact executable ${executable} is missing its executable bit; remove ${generation} to reinstall it`,
              { path: executable },
            ),
          ),
    ),
  );

const cleanup = (fs: FileSystem.FileSystem, path: string): Effect.Effect<void, PreparationError> =>
  fs
    .remove(path, { recursive: true, force: true })
    .pipe(
      Effect.mapError((cause) =>
        artifactError(`Unable to clean artifact temporary path: ${cause.message}`, { path, cause }),
      ),
    );

interface ResolvedGeneration {
  readonly keyRoot: string;
  readonly stagingRoot: string;
  readonly expectedSha256: string;
  readonly generationPath: string;
  readonly lockPath: string;
}

const resolveGeneration = Effect.fn("ArtifactStore.resolveGeneration")(function* (
  path: Path.Path,
  cacheRoot: string,
  source: ArtifactSource,
  request: ArtifactRequest,
): Effect.fn.Return<ResolvedGeneration, ArtifactStoreError, HttpClient.HttpClient> {
  const keyRoot = path.resolve(cacheRoot, request.key);
  if (!pathWithin(cacheRoot, keyRoot, path.sep))
    return yield* artifactError("Artifact key escapes cache root", { key: request.key });
  const expectedSha256 = yield* source.checksum(request).pipe(
    Effect.flatMap((sha256) =>
      validateSha256(sha256).pipe(
        Effect.mapError((cause) =>
          metadataError("Artifact source returned an invalid SHA-256", {
            key: request.key,
            cause,
          }),
        ),
      ),
    ),
  );
  return {
    keyRoot,
    stagingRoot: path.join(keyRoot, STAGING_DIR_NAME),
    expectedSha256,
    generationPath: path.join(keyRoot, expectedSha256),
    lockPath: path.join(keyRoot, `${expectedSha256}.lock`),
  };
});

const stagingDirFor = (path: Path.Path, stagingRoot: string, token: string) =>
  path.join(stagingRoot, token);
const stagingLockFor = (path: Path.Path, stagingRoot: string, token: string) =>
  path.join(stagingRoot, `${token}.lock`);

/** A staging lock's own file, or the rollback journal SQLite leaves while a transaction is open. */
const STAGING_LOCK_SUFFIX = /\.lock(-journal)?$/u;

/**
 * Every `.staging` token with a directory. A bare lock file is skipped: its owner creates the
 * lock before taking it and the directory only afterwards, so reaping it could unlink a lock
 * about to be taken.
 */
const listStagingTokens = (
  fs: FileSystem.FileSystem,
  stagingRoot: string,
): Effect.Effect<ReadonlyArray<string>> =>
  fs.readDirectory(stagingRoot).pipe(
    Effect.map((names) => names.filter((name) => !STAGING_LOCK_SUFFIX.test(name))),
    Effect.orElseSucceed(() => []),
  );

/**
 * Removes a `.staging/<token>` directory and its lock file only when the lock can be taken
 * without blocking: a live preparer or retirer holding it keeps this from ever touching
 * in-progress work. Best-effort: any failure (including contention) is silently skipped.
 */
const reapStagingToken = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  stagingRoot: string,
  token: string,
): Effect.Effect<void> => {
  const lockPath = stagingLockFor(path, stagingRoot, token);
  const dir = stagingDirFor(path, stagingRoot, token);
  return Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* acquireLock(lockPath, "existing").pipe(
        Effect.catchIf(isMissing, () => acquireLock(lockPath, "create")),
      );
      yield* takeLock(connection);
      yield* fs.remove(dir, { recursive: true, force: true });
      yield* fs.remove(lockPath, { force: true });
      yield* fs.remove(`${lockPath}-journal`, { force: true });
    }),
  ).pipe(Effect.ignore);
};

const reapStaleStaging = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  stagingRoot: string,
): Effect.Effect<void> =>
  listStagingTokens(fs, stagingRoot).pipe(
    Effect.flatMap((tokens) =>
      Effect.forEach(tokens, (token) => reapStagingToken(fs, path, stagingRoot, token), {
        discard: true,
        concurrency: 1,
      }),
    ),
  );

/** A symlink is never a cache entry: the cache neither walks nor writes through one. */
const isSymlink = (fs: FileSystem.FileSystem, target: string): Effect.Effect<boolean> =>
  // readLink succeeds only on a symlink.
  fs.readLink(target).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

interface CacheWalk {
  readonly generations: ReadonlyArray<{ readonly keyRoot: string; readonly digest: string }>;
  readonly stagingRoots: ReadonlyArray<string>;
}

/**
 * Recursively walks the cache root and returns every generation (a digest-named directory) and
 * every `.staging` root, without ever descending into either: a key embeds its release version
 * (see `Artifacts.ts`'s `artifactKey`), so a CLI upgrade leaves a previous release's generations
 * behind a now-unreachable key that only a root-wide walk like this ever revisits. A plain
 * directory-name listing, never a generation's own (potentially large) published contents, keeps
 * this cheap.
 */
const walkCache = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
): Effect.Effect<CacheWalk, never> =>
  Effect.gen(function* () {
    const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
    const generations: Array<CacheWalk["generations"][number]> = [];
    const stagingRoots: Array<string> = [];
    for (const name of names) {
      if (yield* isSymlink(fs, path.join(root, name))) continue;
      if (name === STAGING_DIR_NAME) {
        stagingRoots.push(path.join(root, name));
        continue;
      }
      if (DIGEST_NAME.test(name)) {
        generations.push({ keyRoot: root, digest: name });
        continue;
      }
      const nested = yield* walkCache(fs, path, path.join(root, name));
      generations.push(...nested.generations);
      stagingRoots.push(...nested.stagingRoots);
    }
    return { generations, stagingRoots };
  });

/**
 * Retires one generation. The digest lock is held only for the age re-check and the rename into
 * a lock-guarded staging slot, so a concurrent pin is never blocked behind the recursive delete;
 * the slot lock keeps the delete from being reaped while it runs. A crash after the rename leaves
 * an unlocked staging directory that the next sweep reaps.
 */
const retireGeneration = Effect.fn("ArtifactStore.retireGeneration")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  crypto: Crypto.Crypto,
  keyRoot: string,
  digest: string,
): Effect.fn.Return<boolean, never> {
  const generationPath = path.join(keyRoot, digest);
  const lockPath = path.join(keyRoot, `${digest}.lock`);
  const stagingRoot = path.join(keyRoot, STAGING_DIR_NAME);
  const stagingLockPath = yield* Effect.scoped(
    Effect.gen(function* () {
      const slotScope = yield* Scope.Scope;
      const slot = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* acquireLock(lockPath, "existing");
          yield* takeExclusiveLock(connection);
          const info = yield* fs.stat(lockPath);
          const mtime = Option.getOrUndefined(info.mtime);
          const now = yield* Clock.currentTimeMillis;
          if (mtime === undefined || now - mtime.getTime() <= RETIREMENT_AGE_MILLIS)
            return undefined;
          if (yield* isSymlink(fs, stagingRoot)) return undefined;
          yield* fs.makeDirectory(stagingRoot, { recursive: true, mode: 0o700 });
          const token = yield* crypto.randomUUIDv4;
          const slotLockPath = stagingLockFor(path, stagingRoot, token);
          const slotDir = stagingDirFor(path, stagingRoot, token);
          const slotConnection = yield* acquireLock(slotLockPath, "create").pipe(
            Scope.provide(slotScope),
          );
          yield* takeLock(slotConnection);
          yield* fs.rename(generationPath, slotDir);
          return { slotDir, slotLockPath };
        }),
      );
      if (slot === undefined) return undefined;
      yield* fs.remove(slot.slotDir, { recursive: true, force: true });
      return slot.slotLockPath;
    }),
  ).pipe(Effect.orElseSucceed(() => undefined));
  if (stagingLockPath === undefined) return false;
  yield* fs
    .remove(stagingLockPath, { force: true })
    .pipe(Effect.andThen(fs.remove(`${stagingLockPath}-journal`, { force: true })), Effect.ignore);
  return true;
});

/**
 * One best-effort sweep over the whole cache root. It reaps every unlocked `.staging` entry under
 * any key root (a crashed preparer's leftovers), then retires each published generation whose
 * digest lock is uncontended and whose lock-file mtime, rechecked under that lock, is older than
 * the retention window. Digest lock files are never deleted (a stable inode); only the generation
 * directory they guard is. A per-entry failure (including contention from a live pin or another
 * retirer) is skipped, never propagated: this sweep must never block the `prepare`/`use` call it
 * runs alongside. A pin held by this process contends with the sweep's lock exactly as a pin held
 * by another process does.
 */
const sweepCache = Effect.fn("ArtifactStore.sweep")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  crypto: Crypto.Crypto,
  cacheRoot: string,
): Effect.fn.Return<number, never> {
  const { generations, stagingRoots } = yield* walkCache(fs, path, cacheRoot);
  for (const stagingRoot of stagingRoots) yield* reapStaleStaging(fs, path, stagingRoot);
  let retired = 0;
  for (const { keyRoot, digest } of generations) {
    if (yield* retireGeneration(fs, path, crypto, keyRoot, digest)) retired++;
  }
  yield* Effect.annotateCurrentSpan({ "artifact.retired_count": retired });
  return retired;
});

/** A cache hit: the generation directory exists, so every listed path is checked, never rehashed. */
const checkHit = Effect.fn("ArtifactStore.checkHit")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cacheRoot: string,
  request: ArtifactRequest,
  resolved: ResolvedGeneration,
): Effect.fn.Return<Option.Option<PreparedArtifact>, ArtifactStoreError> {
  const exists = yield* mapFs(
    resolved.generationPath,
    "inspect cached artifact",
    fs.exists(resolved.generationPath),
  );
  if (!exists) return Option.none();
  const realRoot = yield* ensureSafeRoot(fs, path, resolved.generationPath, cacheRoot).pipe(
    Effect.catch((error) => (isMissingArtifactRoot(error) ? Effect.void : Effect.fail(error))),
  );
  if (realRoot === undefined) return Option.none();
  const inspected = yield* inspectRequiredPaths(
    fs,
    path,
    resolved.generationPath,
    realRoot,
    request.requiredRuntimePaths,
  );
  if (request.executablePath !== undefined) {
    const executable = inspected[request.executablePath];
    if (executable === undefined)
      return yield* metadataError("Cached artifact executable path is not recorded", {
        path: request.executablePath,
      });
    yield* ensureExecutableFile(fs, executable.realPath);
    yield* ensureExecutableMode(fs, resolved.generationPath, executable.realPath);
  }
  return Option.some({
    key: request.key,
    path: resolved.generationPath,
    lockPath: resolved.lockPath,
    sha256: resolved.expectedSha256,
    requiredRuntimePaths: [...request.requiredRuntimePaths],
    ...(request.executablePath === undefined ? {} : { executablePath: request.executablePath }),
    outcome: "cached" as const,
  });
});

const isPublishTargetTaken = (cause: unknown): boolean =>
  cause instanceof PlatformError.PlatformError &&
  cause.reason instanceof PlatformError.SystemError &&
  hasErrnoCode(cause.reason.cause) &&
  ["EEXIST", "ENOTEMPTY"].includes(String(cause.reason.cause.code));

/**
 * Downloads, validates and publishes a fresh generation. Staged under a lock-guarded
 * `.staging/<uuid>/content`, published by renaming the completed content to `<key>/<digest>` and
 * fsyncing the parent. A losing preparer (publish target already taken) accepts the winner's
 * generation instead of failing, since both staged the same content-addressed digest.
 */
const publishGeneration = Effect.fn("ArtifactStore.publish")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  crypto: Crypto.Crypto,
  childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cacheRoot: string,
  source: ArtifactSource,
  request: ArtifactRequest,
  resolved: ResolvedGeneration,
  onProgress?: (state: "downloading" | "preparing") => void,
): Effect.fn.Return<PreparedArtifact, ArtifactStoreError, HttpClient.HttpClient> {
  yield* mapFs(
    resolved.stagingRoot,
    "create artifact staging root",
    fs.makeDirectory(resolved.stagingRoot, { recursive: true, mode: 0o700 }),
  );
  const token = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) =>
      artifactError(`Unable to allocate artifact staging name: ${cause.message}`, {
        key: request.key,
        cause,
      }),
    ),
  );
  const stagingDir = stagingDirFor(path, resolved.stagingRoot, token);
  const stagingLockPath = stagingLockFor(path, resolved.stagingRoot, token);
  const content = path.join(stagingDir, STAGING_CONTENT_NAME);
  yield* Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* acquireLock(stagingLockPath, "create").pipe(
        Effect.mapError((cause) =>
          artifactError(`Unable to lock artifact staging directory: ${cause.message}`, {
            key: request.key,
            cause,
          }),
        ),
      );
      yield* takeLock(connection).pipe(
        Effect.mapError((cause) =>
          artifactError(`Unable to lock artifact staging directory: ${cause.message}`, {
            key: request.key,
            cause,
          }),
        ),
      );
      yield* ensureDirectory(fs, path, content, cacheRoot);
      const contentRoot = yield* ensureSafeRoot(fs, path, content, cacheRoot);
      yield* source.materialize(request, content, resolved.expectedSha256, onProgress).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
        // The source owns the exact tar process boundary; the store only supplies the
        // already-owned process service captured by its constructor.
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
      const inspected = yield* validateFreshRuntimePaths(
        fs,
        path,
        content,
        contentRoot,
        request.requiredRuntimePaths,
      );
      if (request.executablePath !== undefined) {
        const executable = inspected[request.executablePath];
        if (executable === undefined)
          return yield* metadataError("Fresh artifact executable path is not recorded", {
            path: request.executablePath,
          });
        yield* ensureExecutableFile(fs, executable.realPath);
      }
      yield* mapFs(content, "normalize artifact mode", fs.chmod(content, DIRECTORY_MODE));
      // Protects the narrow window right after publish: the digest lock file's mtime is touched
      // here regardless of any pin the caller already holds, so a generation republished after a
      // past retirement never inherits its lock file's stale, pre-retirement mtime.
      return yield* Effect.scoped(
        Pin.pin(resolved.lockPath).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.mapError((cause) =>
            artifactError(`Unable to pin artifact generation before publishing: ${cause.message}`, {
              key: request.key,
              cause,
            }),
          ),
          Effect.andThen(
            fs.rename(content, resolved.generationPath).pipe(
              Effect.as(true as const),
              Effect.catch((cause) =>
                isPublishTargetTaken(cause)
                  ? Effect.succeed(false as const)
                  : Effect.fail(
                      artifactError(`Unable to publish artifact: ${String(cause)}`, {
                        path: resolved.generationPath,
                        cause,
                      }),
                    ),
              ),
              Effect.flatMap((won) =>
                won
                  ? mapFs(
                      resolved.keyRoot,
                      "publish artifact",
                      fsyncDirectory(fs, resolved.keyRoot),
                    )
                  : Effect.void,
              ),
            ),
          ),
        ),
      );
    }),
  ).pipe(
    Effect.onExit(() =>
      // Runs after the staging lock connection above has already closed (`Effect.scoped`'s own
      // finalizer fires first), so removing its file here is always safe, on every outcome.
      cleanup(fs, stagingDir).pipe(
        Effect.andThen(fs.remove(stagingLockPath, { force: true })),
        Effect.andThen(fs.remove(`${stagingLockPath}-journal`, { force: true })),
        Effect.ignore,
      ),
    ),
  );
  const hit = yield* checkHit(fs, path, cacheRoot, request, resolved);
  if (Option.isNone(hit))
    return yield* artifactError("Unable to publish artifact: the published generation vanished", {
      path: resolved.generationPath,
    });
  return { ...hit.value, outcome: "downloaded" as const };
});

const prepareOrResolve = Effect.fn("ArtifactStore.prepareOrResolve")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  crypto: Crypto.Crypto,
  childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cacheRoot: string,
  source: ArtifactSource,
  request: ArtifactRequest,
  resolved: ResolvedGeneration,
  onProgress?: (state: "downloading" | "preparing") => void,
): Effect.fn.Return<PreparedArtifact, ArtifactStoreError, HttpClient.HttpClient> {
  yield* ensureDirectory(fs, path, resolved.keyRoot, cacheRoot);
  const hit = yield* checkHit(fs, path, cacheRoot, request, resolved);
  if (Option.isSome(hit)) return hit.value;
  const published = yield* publishGeneration(
    fs,
    path,
    crypto,
    childProcessSpawner,
    cacheRoot,
    source,
    request,
    resolved,
    onProgress,
  );
  yield* sweepCache(fs, path, crypto, cacheRoot);
  return published;
});

export const makeArtifactStore = Effect.fn("ArtifactStore.makeStore")(function* (
  options: ArtifactStoreOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  if (options.cacheRoot.trim().length === 0)
    return yield* artifactError("Artifact cache root must not be blank");
  const requestedRoot = path.resolve(options.cacheRoot);
  yield* mapFs(
    requestedRoot,
    "create artifact cache root",
    fs.makeDirectory(requestedRoot, { recursive: true, mode: 0o700 }),
  );
  const cacheRoot = yield* fs.realPath(requestedRoot).pipe(
    Effect.mapError((cause) =>
      artifactError(`Unable to resolve artifact cache root: ${cause.message}`, {
        path: requestedRoot,
        cause,
      }),
    ),
  );
  const rootInfo = yield* fs.stat(cacheRoot).pipe(
    Effect.mapError((cause) =>
      artifactError(`Unable to inspect artifact cache root: ${cause.message}`, {
        path: cacheRoot,
        cause,
      }),
    ),
  );
  if (rootInfo.type !== "Directory")
    return yield* artifactError("Artifact cache root must be a directory", { path: cacheRoot });
  yield* mapFs(cacheRoot, "secure artifact cache root", restrictDirectoryToOwner(fs, cacheRoot));

  const prepare = Effect.fn("ArtifactStore.prepare")(function* (
    request: ArtifactRequest,
    onProgress?: (state: "downloading" | "preparing") => void,
  ) {
    yield* validateRequest(request);
    const resolved = yield* resolveGeneration(path, cacheRoot, options.source, request);
    // Ahead-of-time preparation pins nothing for its caller, but a warm generation's own
    // inspection and a fresh one's publication both still need protection from a concurrent
    // retirement sweep elsewhere; a SHARED pin held only for this call's own duration, released
    // before returning, gives that without leaving anything pinned for the caller.
    yield* ensureDirectory(fs, path, resolved.keyRoot, cacheRoot);
    const prepared = yield* Effect.scoped(
      Pin.pin(resolved.lockPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError((cause) =>
          artifactError(`Unable to pin artifact generation: ${cause.message}`, {
            key: request.key,
            cause,
          }),
        ),
        Effect.andThen(
          prepareOrResolve(
            fs,
            path,
            crypto,
            childProcessSpawner,
            cacheRoot,
            options.source,
            request,
            resolved,
            onProgress,
          ),
        ),
      ),
    );
    yield* Effect.annotateCurrentSpan({
      "artifact.outcome": prepared.outcome,
      "artifact.digest": resolved.expectedSha256,
    });
    return prepared;
  });

  /**
   * The one scoped launch-time operation: pins the generation, resolves or prepares it, and
   * returns its paths. Every consumer must use those paths only inside this scope.
   */
  const use = Effect.fn("ArtifactStore.use")(function* (
    request: ArtifactRequest,
    onProgress?: (state: "downloading" | "preparing") => void,
  ) {
    yield* validateRequest(request);
    const resolved = yield* resolveGeneration(path, cacheRoot, options.source, request);
    // The digest lock file's parent must exist before it can be created; `prepareOrResolve` below
    // ensures it again, idempotently, before resolving or preparing the generation itself.
    yield* ensureDirectory(fs, path, resolved.keyRoot, cacheRoot);
    yield* Pin.pin(resolved.lockPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.mapError((cause) =>
        artifactError(`Unable to pin artifact generation: ${cause.message}`, {
          key: request.key,
          cause,
        }),
      ),
    );
    const prepared = yield* prepareOrResolve(
      fs,
      path,
      crypto,
      childProcessSpawner,
      cacheRoot,
      options.source,
      request,
      resolved,
      onProgress,
    );
    yield* Effect.annotateCurrentSpan({
      "artifact.outcome": prepared.outcome,
      "artifact.digest": resolved.expectedSha256,
    });
    return prepared;
  });

  return { prepare, use };
});
