// oxlint-disable effecttsgo/async-function -- resolver preserves the Edge Runtime Promise callback contract.
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
  readonly lstat: (path: string) => Promise<FunctionFileInfo>;
  readonly realPath: (path: string) => Promise<string>;
  readonly readDirectory: (path: string) => Promise<ReadonlyArray<string>>;
}

const slugPattern = /^[A-Za-z0-9_-]+$/u;
const globPattern = /[*?[{]/u;

const contained = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root.replace(/\/+$/u, "")}/`);

const optionalInfo = async (
  fs: FunctionFileSystem,
  path: string,
): Promise<FunctionFileInfo | undefined> => {
  try {
    return await fs.lstat(path);
  } catch {
    return undefined;
  }
};

const safeRealPath = async (
  fs: FunctionFileSystem,
  root: string,
  candidate: string,
): Promise<boolean> => {
  try {
    const [canonicalRoot, canonicalCandidate] = await Promise.all([
      fs.realPath(root),
      fs.realPath(candidate),
    ]);
    return contained(canonicalRoot, canonicalCandidate);
  } catch {
    return false;
  }
};

/** Rejects symlinks in the complete wildcard search area for this request. */
const rejectSymlinkDescendants = async (
  fs: FunctionFileSystem,
  root: string,
  directory: string,
): Promise<boolean> => {
  const info = await optionalInfo(fs, directory);
  if (info === undefined) return true;
  if (info.isSymbolicLink || !(await safeRealPath(fs, root, directory))) return false;
  if (!info.isDirectory) return true;
  let children: ReadonlyArray<string>;
  try {
    children = await fs.readDirectory(directory);
  } catch {
    return false;
  }
  for (const child of children) {
    if (!(await rejectSymlinkDescendants(fs, root, join(directory, child)))) return false;
  }
  return true;
};

const relativePath = (base: string, value: string): string =>
  value.length === 0 ? "" : value.startsWith("/") ? value : join(base, value);

/** Resolves one request's persisted override/default against the live functions tree. */
export const resolveFunctionConfig = async (options: {
  readonly root: string;
  readonly slug: string;
  readonly overrides: FunctionOverrides;
  readonly fs: FunctionFileSystem;
}): Promise<FunctionConfig | undefined> => {
  const { root, slug, overrides, fs } = options;
  if (!root.startsWith("/") || !slugPattern.test(slug) || slug === "_shared") return undefined;
  const rootInfo = await optionalInfo(fs, root);
  // The configured functions root itself may be a symlink; descendants remain
  // subject to canonical containment and entrypoint symlink rejection below.
  if (rootInfo === undefined) return undefined;
  const canonicalRoot = await fs.realPath(root).catch(() => "");
  if (!canonicalRoot.startsWith("/")) return undefined;
  const canonicalInfo = await optionalInfo(fs, canonicalRoot);
  if (canonicalInfo === undefined || !canonicalInfo.isDirectory) return undefined;
  const globalDefaults = overrides.$default;
  const functionOverride = overrides[slug];
  // `$default` cannot be a function slug (the slug schema only accepts letters,
  // digits, `_`, and `-`) and therefore provides a collision-free global
  // default for functions discovered after the stack started. A closed
  // per-function override is spread last so it always wins.
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
    const directoryInfo = await optionalInfo(fs, functionDirectory);
    if (directoryInfo === undefined || !directoryInfo.isDirectory) return undefined;
    if (!(await safeRealPath(fs, canonicalRoot, functionDirectory))) return undefined;
  }
  const entrypointPath = relativePath(functionDirectory, rawEntrypoint);
  if (!(await safeRealPath(fs, canonicalRoot, entrypointPath))) return undefined;
  const entrypointInfo = await optionalInfo(fs, entrypointPath);
  if (entrypointInfo === undefined || !entrypointInfo.isFile || entrypointInfo.isSymbolicLink)
    return undefined;

  // Per-function import maps are relative to that function's directory. The
  // reserved global default is explicitly root-relative, so one shared map is
  // reused by every slug (including slugs created after serve starts).
  const functionImportMap = functionOverride?.importMapPath ?? functionOverride?.import_map;
  const globalImportMap = globalDefaults?.importMapRoot ?? globalDefaults?.import_map_root;
  let importMapPath =
    functionImportMap !== undefined
      ? relativePath(functionDirectory, functionImportMap)
      : globalImportMap !== undefined
        ? relativePath(canonicalRoot, globalImportMap)
        : relativePath(functionDirectory, "");
  if (importMapPath.length > 0) {
    if (!(await safeRealPath(fs, canonicalRoot, importMapPath))) return undefined;
    const info = await optionalInfo(fs, importMapPath);
    if (info === undefined || !info.isFile || info.isSymbolicLink) return undefined;
  } else {
    for (const candidate of ["deno.json", "deno.jsonc"]) {
      const path = join(functionDirectory, candidate);
      const info = await optionalInfo(fs, path);
      if (info !== undefined) {
        if (!info.isFile || info.isSymbolicLink || !(await safeRealPath(fs, canonicalRoot, path)))
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
    if (!(await rejectSymlinkDescendants(fs, canonicalRoot, searchRoot))) return undefined;
    if (!globPattern.test(pattern)) {
      const info = await optionalInfo(fs, pattern);
      if (
        info !== undefined &&
        (!(await safeRealPath(fs, canonicalRoot, pattern)) || info.isSymbolicLink)
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
};

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
export const packageJsonContainedFor = async (options: {
  readonly root: string;
  readonly config: FunctionConfig;
  readonly fs: FunctionFileSystem;
}): Promise<boolean> => {
  if (!options.root.startsWith("/")) return false;
  const rootInfo = await optionalInfo(options.fs, options.root);
  if (rootInfo === undefined || (!rootInfo.isDirectory && !rootInfo.isSymbolicLink)) return false;
  const canonicalRoot = await options.fs.realPath(options.root).catch(() => "");
  if (!canonicalRoot.startsWith("/")) return false;
  const canonicalInfo = await optionalInfo(options.fs, canonicalRoot);
  if (canonicalInfo === undefined || !canonicalInfo.isDirectory) return false;
  const packagePath = packageJsonPathFor(options.config);
  const packageInfo = await optionalInfo(options.fs, packagePath);
  if (packageInfo === undefined || !packageInfo.isFile || packageInfo.isSymbolicLink) return false;
  return safeRealPath(options.fs, canonicalRoot, packagePath);
};
