import { Data, Effect } from "effect";
import { dirname, join } from "./serve-main-deps.ts";

interface FunctionOverride {
  readonly enabled?: boolean;
  readonly verifyJWT?: boolean;
  readonly verify_jwt?: boolean;
  readonly entrypointPath?: string;
  readonly entrypoint?: string;
  readonly importMapPath?: string;
  readonly import_map?: string;
  /** Reserved `$default` field: path relative to the shared functions root. */
  readonly importMapRoot?: string;
  readonly import_map_root?: string;
  readonly staticFiles?: ReadonlyArray<string>;
  readonly static_files?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

/** Persisted per-function overrides plus the reserved global defaults entry. */
export type FunctionOverrides = Readonly<Record<string, FunctionOverride>>;

export interface FunctionConfig {
  readonly entrypointPath: string;
  readonly importMapPath: string;
  readonly staticFiles: ReadonlyArray<string>;
  readonly verifyJWT: boolean;
  readonly env?: Readonly<Record<string, string>>;
}

interface FunctionFileInfo {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

/** The tiny filesystem surface needed by request-time function discovery. */
export interface FunctionFileSystem {
  readonly lstat: (path: string) => Effect.Effect<FunctionFileInfo, FunctionFileSystemError>;
  readonly realPath: (path: string) => Effect.Effect<string, FunctionFileSystemError>;
  readonly readDirectory: (
    path: string,
  ) => Effect.Effect<ReadonlyArray<string>, FunctionFileSystemError>;
}

const slugPattern = /^[A-Za-z0-9_-]+$/u;
const globPattern = /[*?[{]/u;

const contained = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root.replace(/\/+$/u, "")}/`);

export class FunctionFileSystemError extends Data.TaggedError("FunctionFileSystemError")<{
  readonly cause: unknown;
}> {}
const optionalInfo = (
  fs: FunctionFileSystem,
  path: string,
): Effect.Effect<FunctionFileInfo | undefined> =>
  fs.lstat(path).pipe(Effect.catch(() => Effect.undefined));

const safeRealPath = (
  fs: FunctionFileSystem,
  root: string,
  candidate: string,
): Effect.Effect<boolean> =>
  Effect.all([fs.realPath(root), fs.realPath(candidate)], {
    concurrency: 2,
  }).pipe(
    Effect.map(([canonicalRoot, canonicalCandidate]) =>
      contained(canonicalRoot, canonicalCandidate),
    ),
    Effect.orElseSucceed(() => false),
  );

const rejectSymlinkDescendants = (
  fs: FunctionFileSystem,
  root: string,
  directory: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const info = yield* optionalInfo(fs, directory);
    if (info === undefined) return true;
    if (info.isSymbolicLink || !(yield* safeRealPath(fs, root, directory))) return false;
    if (!info.isDirectory) return true;
    const children = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.undefined));
    if (children === undefined) return false;
    for (const child of children) {
      if (!(yield* rejectSymlinkDescendants(fs, root, join(directory, child)))) return false;
    }
    return true;
  });

const relativePath = (base: string, value: string): string =>
  value.length === 0 ? "" : value.startsWith("/") ? value : join(base, value);

/** Resolves one request's persisted override/default against the live functions tree. */
export const resolveFunctionConfig = (options: {
  readonly root: string;
  readonly slug: string;
  readonly overrides: FunctionOverrides;
  readonly fs: FunctionFileSystem;
}): Effect.Effect<FunctionConfig | undefined> =>
  Effect.gen(function* () {
    const { root, slug, overrides, fs } = options;
    if (!root.startsWith("/") || !slugPattern.test(slug) || slug === "_shared") return undefined;
    const rootInfo = yield* optionalInfo(fs, root);
    // The configured functions root itself may be a symlink; descendants remain
    // subject to canonical containment and entrypoint symlink rejection below.
    if (rootInfo === undefined) return undefined;
    const canonicalRoot = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => ""));
    if (!canonicalRoot.startsWith("/")) return undefined;
    const canonicalInfo = yield* optionalInfo(fs, canonicalRoot);
    if (canonicalInfo === undefined || !canonicalInfo.isDirectory) return undefined;
    const globalDefaults = overrides.$default;
    const functionOverride = overrides[slug];
    // `$default` cannot be a function slug (the slug schema only accepts letters, digits, `_`,
    // and `-`), so it's a collision-free global default; the per-function override is spread
    // last so it always wins.
    const override = {
      ...globalDefaults,
      ...functionOverride,
    };
    if (override.enabled === false) return undefined;
    const functionDirectory = join(canonicalRoot, slug);
    const rawEntrypoint =
      override?.entrypointPath && override.entrypointPath.length > 0
        ? override.entrypointPath
        : override.entrypoint && override.entrypoint.length > 0
          ? override.entrypoint
          : "index.ts";
    if (!rawEntrypoint.startsWith("/")) {
      const directoryInfo = yield* optionalInfo(fs, functionDirectory);
      if (directoryInfo === undefined || !directoryInfo.isDirectory) return undefined;
      if (!(yield* safeRealPath(fs, canonicalRoot, functionDirectory))) return undefined;
    }
    const entrypointPath = relativePath(functionDirectory, rawEntrypoint);
    if (!(yield* safeRealPath(fs, canonicalRoot, entrypointPath))) return undefined;
    const entrypointInfo = yield* optionalInfo(fs, entrypointPath);
    if (entrypointInfo === undefined || !entrypointInfo.isFile || entrypointInfo.isSymbolicLink)
      return undefined;

    // Per-function import maps are relative to that function's directory; the reserved global
    // default is root-relative, so one shared map is reused by every slug.
    const functionImportMap = functionOverride?.importMapPath ?? functionOverride?.import_map;
    const globalImportMap = globalDefaults?.importMapRoot ?? globalDefaults?.import_map_root;
    let importMapPath =
      functionImportMap !== undefined
        ? relativePath(functionDirectory, functionImportMap)
        : globalImportMap !== undefined
          ? relativePath(canonicalRoot, globalImportMap)
          : relativePath(functionDirectory, "");
    if (importMapPath.length > 0) {
      if (!(yield* safeRealPath(fs, canonicalRoot, importMapPath))) return undefined;
      const info = yield* optionalInfo(fs, importMapPath);
      if (info === undefined || !info.isFile || info.isSymbolicLink) return undefined;
    } else {
      for (const candidate of ["deno.json", "deno.jsonc"]) {
        const path = join(functionDirectory, candidate);
        const info = yield* optionalInfo(fs, path);
        if (info !== undefined) {
          if (
            !info.isFile ||
            info.isSymbolicLink ||
            !(yield* safeRealPath(fs, canonicalRoot, path))
          )
            return undefined;
          importMapPath = path;
          break;
        }
      }
    }

    const staticFiles = (override.staticFiles ?? override.static_files ?? []).map((pattern) =>
      relativePath(functionDirectory, pattern),
    );
    for (const pattern of staticFiles) {
      if (!contained(canonicalRoot, pattern)) return undefined;
      const wildcardIndex = pattern.search(globPattern);
      const prefix = wildcardIndex < 0 ? pattern : pattern.slice(0, wildcardIndex);
      const searchRoot =
        wildcardIndex < 0
          ? dirname(pattern)
          : prefix.slice(0, Math.max(0, prefix.lastIndexOf("/"))) || canonicalRoot;
      if (!(yield* rejectSymlinkDescendants(fs, canonicalRoot, searchRoot))) return undefined;
      if (!globPattern.test(pattern)) {
        const info = yield* optionalInfo(fs, pattern);
        if (
          info !== undefined &&
          (!(yield* safeRealPath(fs, canonicalRoot, pattern)) || info.isSymbolicLink)
        )
          return undefined;
      }
    }

    return {
      entrypointPath,
      importMapPath,
      staticFiles,
      verifyJWT: override.verifyJWT ?? override.verify_jwt ?? true,
      env: override.env,
    };
  });

const packageJsonPathFor = (config: FunctionConfig): string =>
  join(dirname(config.entrypointPath), "package.json");

/** Gives dynamically discovered functions stable, distinct Edge Runtime worker identities. */
export const createWorkerServicePathResolver = (makeTempDirectory: () => string) => {
  const sourceOwners = new Map<string, string>();
  const assigned = new Map<string, string>();
  return (slug: string, config: FunctionConfig): string => {
    const existing = assigned.get(slug);
    if (existing !== undefined) return existing;
    const sourcePath = dirname(config.entrypointPath);
    const owner = sourceOwners.get(sourcePath);
    const servicePath = owner === undefined || owner === slug ? sourcePath : makeTempDirectory();
    if (owner === undefined) sourceOwners.set(sourcePath, slug);
    assigned.set(slug, servicePath);
    return servicePath;
  };
};

/** Checks package discovery without allowing a package.json symlink to leave the root. */
export const packageJsonContainedFor = (options: {
  readonly root: string;
  readonly config: FunctionConfig;
  readonly fs: FunctionFileSystem;
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!options.root.startsWith("/")) return false;
    const rootInfo = yield* optionalInfo(options.fs, options.root);
    if (rootInfo === undefined || (!rootInfo.isDirectory && !rootInfo.isSymbolicLink)) return false;
    const canonicalRoot = yield* options.fs
      .realPath(options.root)
      .pipe(Effect.orElseSucceed(() => ""));
    if (!canonicalRoot.startsWith("/")) return false;
    const canonicalInfo = yield* optionalInfo(options.fs, canonicalRoot);
    if (canonicalInfo === undefined || !canonicalInfo.isDirectory) return false;
    const packagePath = packageJsonPathFor(options.config);
    const packageInfo = yield* optionalInfo(options.fs, packagePath);
    if (packageInfo === undefined || !packageInfo.isFile || packageInfo.isSymbolicLink)
      return false;
    return yield* safeRealPath(options.fs, canonicalRoot, packagePath);
  });
