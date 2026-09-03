import {
  Crypto,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Path,
  PlatformError,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ArtifactIntegrityError, StackPreparationError } from "../public/Errors.ts";
import { validateRelativePath, validateSha256, verifySha256 } from "./Integrity.ts";

/**
 * A concrete artifact identity. `key` is deliberately private to preparation and may contain
 * subdirectories, but never an absolute or traversing path.
 */
export interface ArtifactRequest {
  readonly key: string;
  readonly sha256: string;
  /** Relative paths that a runtime may use after installation. */
  readonly requiredRuntimePaths: ReadonlyArray<string>;
  /** The relative executable path, if this artifact starts a native workload. */
  readonly executablePath?: string;
}

/**
 * The source is the only download/archive boundary. It writes an unpacked artifact tree below
 * `destination` and returns the exact bytes whose SHA-256 identifies the catalog entry (normally
 * the downloaded tar.zst archive). A future network/archive adapter can stream and unpack there;
 * the store itself remains independent of transport and archive formats.
 */
export interface ArtifactSource {
  readonly materialize: (
    request: ArtifactRequest,
    destination: string,
  ) => Effect.Effect<
    Uint8Array,
    StackPreparationError,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner
  >;
}

export interface ArtifactStoreOptions {
  readonly cacheRoot: string;
  readonly source: ArtifactSource;
}

export interface PreparedArtifact {
  readonly key: string;
  /** Installed artifact directory. Required runtime paths are relative to this directory. */
  readonly path: string;
  readonly sha256: string;
  readonly requiredRuntimePaths: ReadonlyArray<string>;
  readonly executablePath?: string;
  readonly outcome: "cached" | "downloaded";
}

export type ArtifactStoreError = StackPreparationError | ArtifactIntegrityError;

export interface ArtifactStore {
  readonly prepare: (
    request: ArtifactRequest,
  ) => Effect.Effect<PreparedArtifact, ArtifactStoreError>;
}

const ARTIFACT_FORMAT = "supabase-stack-artifact-v3";
const METADATA_NAME = ".artifact.json";
const EXECUTABLE_MODE = 0o755;

type ArtifactPathKind = "file" | "directory" | "symlink";

type InspectedArtifactPath = {
  readonly kind: ArtifactPathKind;
  readonly realPath: string;
  readonly linkText?: string;
};

const artifactError = (message: string, fields: Readonly<Record<string, unknown>> = {}) =>
  new StackPreparationError({ ...fields, message });

const metadataError = (message: string, fields: Readonly<Record<string, unknown>> = {}) =>
  new ArtifactIntegrityError({ ...fields, message });

const ArtifactMetadataSchema = Schema.Struct({
  format: Schema.Literal(ARTIFACT_FORMAT),
  key: Schema.String,
  sha256: Schema.String,
  requiredRuntimePaths: Schema.Array(Schema.String),
  requiredRuntimeKinds: Schema.Record(
    Schema.String,
    Schema.Literals(["file", "directory", "symlink"]),
  ),
  executablePath: Schema.optional(Schema.String),
});
type ArtifactMetadata = Schema.Schema.Type<typeof ArtifactMetadataSchema>;

const mapFs = <A>(
  path: string,
  operation: string,
  effect: Effect.Effect<A, PlatformError.PlatformError>,
): Effect.Effect<A, StackPreparationError> =>
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

const validateKey = (key: string): Effect.Effect<void, StackPreparationError> =>
  validateRelativePath(key, "artifact key").pipe(
    Effect.flatMap(() =>
      /^[A-Za-z0-9][A-Za-z0-9._-]*(?:[\\/][A-Za-z0-9][A-Za-z0-9._-]*)*$/u.test(key)
        ? Effect.void
        : Effect.fail(artifactError("Artifact key contains unsupported characters", { key })),
    ),
  );

const validateRequest = (
  request: ArtifactRequest,
): Effect.Effect<string, StackPreparationError | ArtifactIntegrityError> =>
  Effect.gen(function* () {
    yield* validateKey(request.key);
    const sha256 = yield* validateSha256(request.sha256);
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
    return sha256;
  });

const requestFlightKey = (request: ArtifactRequest, expectedSha256: string): string =>
  [request.key, expectedSha256, ...request.requiredRuntimePaths, request.executablePath ?? ""].join(
    "\u0000",
  );

const metadataFor = (
  request: ArtifactRequest,
  sha256: string,
  requiredRuntimeKinds: Readonly<Record<string, ArtifactPathKind>>,
): ArtifactMetadata => ({
  format: ARTIFACT_FORMAT,
  key: request.key,
  sha256,
  requiredRuntimePaths: [...request.requiredRuntimePaths],
  requiredRuntimeKinds,
  ...(request.executablePath === undefined ? {} : { executablePath: request.executablePath }),
});

const encodeMetadata = (metadata: ArtifactMetadata): Effect.Effect<string, StackPreparationError> =>
  Schema.encodeEffect(Schema.fromJsonString(ArtifactMetadataSchema))(metadata).pipe(
    Effect.mapError((cause) =>
      artifactError(`Unable to encode artifact metadata: ${String(cause)}`),
    ),
  );

const readMetadata = (
  fs: FileSystem.FileSystem,
  metadataPath: string,
): Effect.Effect<ArtifactMetadata, ArtifactIntegrityError> =>
  fs.readFileString(metadataPath).pipe(
    Effect.mapError((cause) =>
      metadataError("Cached artifact metadata is unreadable", { path: metadataPath, cause }),
    ),
    Effect.flatMap((text) =>
      Schema.decodeEffect(Schema.fromJsonString(ArtifactMetadataSchema))(text).pipe(
        Effect.mapError((cause) =>
          metadataError("Cached artifact metadata is malformed", { path: metadataPath, cause }),
        ),
      ),
    ),
  );

const ensureDirectory = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
  canonicalRoot: string,
): Effect.Effect<void, StackPreparationError> =>
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
      if (!exists) break;
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
    }
    yield* mapFs(
      resolved,
      "create artifact directory",
      fs.makeDirectory(resolved, { recursive: true, mode: 0o700 }),
    );
    const real = yield* fs.realPath(resolved).pipe(
      Effect.mapError((cause) =>
        artifactError(`Unable to resolve artifact directory: ${cause.message}`, {
          path: resolved,
          cause,
        }),
      ),
    );
    if (real !== resolved)
      return yield* artifactError("Artifact directory contains a symlink", { path: resolved });
    if (!pathAtOrBelow(root, real, path.sep))
      return yield* artifactError("Artifact directory escapes cache root", { path: resolved });
    yield* mapFs(resolved, "secure artifact directory", fs.chmod(resolved, 0o700));
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

const ensureSafePaths = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  realRoot: string,
  metadata: ArtifactMetadata,
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
        return yield* metadataError("Cached artifact is missing a required runtime path", {
          path: relative,
        });
      const inspected = yield* inspectFreshPath(fs, path, candidate, realRoot);
      const expectedKind = metadata.requiredRuntimeKinds[relative];
      if (expectedKind === undefined || inspected.kind !== expectedKind)
        return yield* metadataError("Cached artifact runtime path changed basic kind", {
          path: relative,
          expected: expectedKind,
          actual: inspected.kind,
        });
      entries.push([relative, inspected]);
    }
    return Object.fromEntries(entries);
  });

const ensureExecutableFile = (
  fs: FileSystem.FileSystem,
  executable: string,
): Effect.Effect<void, ArtifactIntegrityError> => {
  return fs.stat(executable).pipe(
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
};

const verifyMetadata = (
  request: ArtifactRequest,
  expectedSha256: string,
  metadata: ArtifactMetadata,
): Effect.Effect<void, ArtifactIntegrityError> => {
  const samePaths =
    metadata.requiredRuntimePaths.length === request.requiredRuntimePaths.length &&
    metadata.requiredRuntimePaths.every(
      (entry, index) => entry === request.requiredRuntimePaths[index],
    );
  const kindEntries = Object.keys(metadata.requiredRuntimeKinds);
  const sameKinds =
    kindEntries.length === request.requiredRuntimePaths.length &&
    request.requiredRuntimePaths.every(
      (entry) => metadata.requiredRuntimeKinds[entry] !== undefined,
    );
  if (
    metadata.key !== request.key ||
    metadata.sha256 !== expectedSha256 ||
    !samePaths ||
    !sameKinds ||
    metadata.executablePath !== request.executablePath
  )
    return Effect.fail(
      metadataError("Cached artifact metadata does not match the request", { key: request.key }),
    );
  return Effect.void;
};

const writeBytesSync = (
  fs: FileSystem.FileSystem,
  path: string,
  bytes: Uint8Array,
): Effect.Effect<void, StackPreparationError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(path, { flag: "wx", mode: 0o600 }).pipe(
        Effect.mapError((cause) =>
          artifactError(`Unable to create artifact source file: ${cause.message}`, {
            path,
            cause,
          }),
        ),
      );
      yield* file.writeAll(bytes).pipe(
        Effect.mapError((cause) =>
          artifactError(`Unable to write artifact source file: ${cause.message}`, {
            path,
            cause,
          }),
        ),
      );
      yield* file.sync.pipe(
        Effect.mapError((cause) =>
          artifactError(`Unable to sync artifact source file: ${cause.message}`, { path, cause }),
        ),
      );
    }),
  );

const writeMetadataSync = (
  fs: FileSystem.FileSystem,
  path: string,
  metadata: ArtifactMetadata,
): Effect.Effect<void, StackPreparationError> =>
  Effect.gen(function* () {
    const encoded = yield* encodeMetadata(metadata);
    yield* writeBytesSync(fs, path, new TextEncoder().encode(encoded));
  });

const cleanup = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<void, StackPreparationError> =>
  fs
    .remove(path, { recursive: true, force: true })
    .pipe(
      Effect.mapError((cause) =>
        artifactError(`Unable to clean artifact temporary path: ${cause.message}`, { path, cause }),
      ),
    );

const makeArtifactOperation = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  crypto: Crypto.Crypto,
  childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cacheRoot: string,
  source: ArtifactSource,
  request: ArtifactRequest,
  expectedSha256: string,
): Effect.Effect<PreparedArtifact, ArtifactStoreError> =>
  Effect.gen(function* () {
    const target = path.resolve(cacheRoot, request.key);
    const targetParent = path.dirname(target);
    yield* ensureDirectory(fs, path, targetParent, cacheRoot);
    const targetExists = yield* mapFs(target, "inspect cached artifact", fs.exists(target));
    const cachedRoot = targetExists
      ? yield* ensureSafeRoot(fs, path, target, cacheRoot)
      : undefined;
    const metadataPath = path.join(target, METADATA_NAME);
    const checkCached: Effect.Effect<PreparedArtifact, ArtifactIntegrityError> = Effect.gen(
      function* () {
        const realRoot = cachedRoot ?? (yield* ensureSafeRoot(fs, path, target, cacheRoot));
        const metadata = yield* readMetadata(fs, metadataPath);
        yield* verifyMetadata(request, expectedSha256, metadata);
        // Published content is intentionally not rehashed on cache hits. Metadata and cheap
        // structural checks protect the cache boundary; content tampering may execute or fail
        // later when the workload starts.
        const safePaths = yield* ensureSafePaths(
          fs,
          path,
          target,
          realRoot,
          metadata,
          request.requiredRuntimePaths,
        );
        if (request.executablePath !== undefined) {
          const executable = safePaths[request.executablePath];
          if (executable === undefined)
            return yield* metadataError("Cached artifact executable path is not recorded", {
              path: request.executablePath,
            });
          yield* ensureExecutableFile(fs, executable.realPath);
        }
        return {
          key: request.key,
          path: target,
          sha256: expectedSha256,
          requiredRuntimePaths: [...request.requiredRuntimePaths],
          ...(request.executablePath === undefined
            ? {}
            : { executablePath: request.executablePath }),
          outcome: "cached" as const,
        };
      },
    );
    if (targetExists) return yield* checkCached;

    const token = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) =>
        artifactError(`Unable to allocate artifact temporary name: ${cause.message}`, {
          key: request.key,
          cause,
        }),
      ),
    );
    const temporary = path.join(targetParent, `.${path.basename(target)}.${token}.tmp`);
    yield* ensureDirectory(fs, path, temporary, cacheRoot);
    const temporaryRoot = yield* ensureSafeRoot(fs, path, temporary, cacheRoot);
    const published = yield* Effect.gen(function* () {
      const archive = yield* source.materialize(request, temporary).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
        // The source owns the exact tar process boundary; the store only supplies the
        // already-owned process service captured by its constructor.
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
      yield* verifySha256(archive, expectedSha256).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.mapError((error) =>
          metadataError("Downloaded artifact failed integrity verification", {
            key: request.key,
            cause: error,
          }),
        ),
      );
      const runtimePaths = yield* validateFreshRuntimePaths(
        fs,
        path,
        temporary,
        temporaryRoot,
        request.requiredRuntimePaths,
      );
      const runtimeKinds = Object.fromEntries(
        Object.entries(runtimePaths).map(([relative, inspected]) => [relative, inspected.kind]),
      );
      yield* writeMetadataSync(
        fs,
        path.join(temporary, METADATA_NAME),
        metadataFor(request, expectedSha256, runtimeKinds),
      );
      if (request.executablePath !== undefined) {
        const executable = runtimePaths[request.executablePath];
        if (executable === undefined)
          return yield* metadataError("Fresh artifact executable path is not recorded", {
            path: request.executablePath,
          });
        yield* ensureExecutableFile(fs, executable.realPath);
        yield* mapFs(
          executable.realPath,
          "set executable artifact mode",
          fs.chmod(executable.realPath, EXECUTABLE_MODE),
        );
      }
      const nowExists = yield* mapFs(target, "inspect concurrent artifact", fs.exists(target));
      if (nowExists) {
        const cached = yield* checkCached;
        return cached;
      }
      const rename = mapFs(temporary, "publish artifact", fs.rename(temporary, target)).pipe(
        Effect.as(undefined),
      );
      const recoverPublish = (
        error: StackPreparationError,
      ): Effect.Effect<PreparedArtifact | undefined, ArtifactStoreError> =>
        Effect.gen(function* () {
          const exists = yield* mapFs(target, "inspect concurrent artifact", fs.exists(target));
          if (exists) {
            const cached = yield* checkCached;
            return cached;
          }
          return yield* error;
        });
      const recovered: Effect.Effect<PreparedArtifact | undefined, ArtifactStoreError> =
        rename.pipe(Effect.catch(recoverPublish));
      return yield* recovered;
    }).pipe(Effect.onExit(() => cleanup(fs, temporary)));
    if (published !== undefined) return published;
    return {
      key: request.key,
      path: target,
      sha256: expectedSha256,
      requiredRuntimePaths: [...request.requiredRuntimePaths],
      ...(request.executablePath === undefined ? {} : { executablePath: request.executablePath }),
      outcome: "downloaded" as const,
    };
  });

export const makeArtifactStore = (
  options: ArtifactStoreOptions,
): Effect.Effect<
  ArtifactStore,
  StackPreparationError,
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | Scope.Scope
  | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
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
    yield* mapFs(cacheRoot, "secure artifact cache root", fs.chmod(cacheRoot, 0o700));
    const ownerScope = yield* Scope.make("parallel");
    const parentScope = yield* Scope.Scope;
    yield* Scope.addFinalizer(parentScope, Scope.close(ownerScope, Exit.void));
    const lifecycle = yield* Semaphore.make(1);
    type InFlight = {
      readonly result: Deferred.Deferred<PreparedArtifact, ArtifactStoreError>;
    };
    const inFlight = new Map<string, InFlight>();
    const prepare = (request: ArtifactRequest) =>
      Effect.gen(function* () {
        const expectedSha256 = yield* validateRequest(request);
        const target = path.resolve(cacheRoot, request.key);
        if (!pathWithin(cacheRoot, target, path.sep))
          return yield* artifactError("Artifact key escapes cache root", { key: request.key });
        const flightKey = requestFlightKey(request, expectedSha256);
        const operation = makeArtifactOperation(
          fs,
          path,
          crypto,
          childProcessSpawner,
          cacheRoot,
          options.source,
          request,
          expectedSha256,
        );
        const joined = yield* lifecycle.withPermit(
          Effect.gen(function* () {
            const existing = inFlight.get(flightKey);
            if (existing !== undefined) {
              return existing;
            }
            const result = yield* Deferred.make<PreparedArtifact, ArtifactStoreError>();
            const record: InFlight = { result };
            inFlight.set(flightKey, record);
            yield* Effect.forkIn(
              Effect.gen(function* () {
                const exit = yield* Effect.exit(operation);
                yield* lifecycle.withPermit(
                  Effect.uninterruptible(
                    Effect.gen(function* () {
                      inFlight.delete(flightKey);
                      yield* Deferred.done(record.result, exit);
                    }),
                  ),
                );
              }),
              ownerScope,
            );
            return record;
          }),
        );
        // Waiting is intentionally independent from the owner. Interrupting any caller only
        // stops its await; the Supervisor-owned preparation continues until completion or store
        // scope closure so a later caller can join the same result.
        return yield* Deferred.await(joined.result);
      });
    return { prepare };
  });
