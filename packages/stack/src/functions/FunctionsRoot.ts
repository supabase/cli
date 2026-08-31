import { Data, Effect, FileSystem, Path } from "effect";

export class FunctionNotFoundError extends Data.TaggedError("FunctionNotFoundError")<{
  readonly slug?: string;
  readonly path?: string;
  readonly message: string;
}> {}

export class FunctionPathError extends Data.TaggedError("FunctionPathError")<{
  readonly path?: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

const FUNCTIONS_CONTAINER_ROOT = "/__supabase_functions";

export interface FunctionsRootOptions {
  /** The configured functionsRoot; Compiler supplies an absolute path. */
  readonly root: string;
}

interface ContainerMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: true;
}

export interface FunctionsContainerMapping {
  readonly root: string;
  readonly mount: ContainerMount;
}

export interface ContainedPath {
  readonly native: string;
  readonly relative: string;
  readonly container: string;
  readonly kind: "file" | "directory" | "pattern";
}

export interface FunctionsRoot {
  readonly configuredRoot: string;
  /** Resolve the current canonical root and its sole read-only container mount. */
  readonly mount: Effect.Effect<
    FunctionsContainerMapping,
    FunctionNotFoundError | FunctionPathError,
    FileSystem.FileSystem
  >;
  /** Resolve a root-relative path after refreshing root realpath and containment. */
  readonly resolveContained: (
    relative: string,
    options?: { readonly kind?: "file" | "directory" | "pattern" },
  ) => Effect.Effect<
    ContainedPath,
    FunctionNotFoundError | FunctionPathError,
    FileSystem.FileSystem
  >;
  /** Resolve a function-relative path using the same containment authority. */
  readonly resolveFunctionPath: (
    slug: string,
    relative: string,
    options?: { readonly kind?: "file" | "directory" | "pattern" },
  ) => Effect.Effect<
    ContainedPath,
    FunctionNotFoundError | FunctionPathError,
    FileSystem.FileSystem
  >;
  /** Resolve a local module relative to a contained file; ../_shared is allowed. */
  readonly resolveModulePath: (
    base: ContainedPath,
    relative: string,
  ) => Effect.Effect<
    ContainedPath,
    FunctionNotFoundError | FunctionPathError,
    FileSystem.FileSystem
  >;
}

const pathError = (message: string, path?: string, cause?: unknown) =>
  new FunctionPathError({
    message,
    ...(path === undefined ? {} : { path }),
    ...(cause === undefined ? {} : { cause }),
  });

const notFound = (message: string, slug?: string, path?: string) =>
  new FunctionNotFoundError({
    message,
    ...(slug === undefined ? {} : { slug }),
    ...(path === undefined ? {} : { path }),
  });

const hasLexicalEscape = (relative: string): boolean => {
  if (relative.length === 0) return false;
  return relative.split(/[\\/]/u).some((segment) => segment === "..");
};

const isInside = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

const patternBase = (path: Path.Path, relative: string): string => {
  const parts = relative.split(/[\\/]/u);
  const fixed: string[] = [];
  for (const part of parts) {
    if (/[?*[{]/u.test(part)) break;
    fixed.push(part);
  }
  return path.join(...fixed);
};

const containerPath = (relative: string): string =>
  relative.length === 0
    ? FUNCTIONS_CONTAINER_ROOT
    : `${FUNCTIONS_CONTAINER_ROOT}/${relative.replaceAll(/[\\/]/gu, "/")}`;

/**
 * FunctionsRoot is the sole filesystem authority for the Functions runtime.
 * It intentionally does not cache root existence or child membership: every
 * resolver call re-reads and realpaths the configured root.
 */
export const makeFunctionsRoot = (
  options: FunctionsRootOptions,
): Effect.Effect<FunctionsRoot, FunctionPathError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    if (!path.isAbsolute(options.root))
      return yield* pathError("functionsRoot must be absolute", options.root);
    const configuredRoot = path.resolve(options.root);
    const containerRoot = FUNCTIONS_CONTAINER_ROOT;

    const resolveContained = (
      relative: string,
      resolveOptions: { readonly kind?: "file" | "directory" | "pattern" } = {},
    ): Effect.Effect<
      ContainedPath,
      FunctionNotFoundError | FunctionPathError,
      FileSystem.FileSystem
    > =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        if (path.isAbsolute(relative) || hasLexicalEscape(relative))
          return yield* pathError("Function path escapes functionsRoot", relative);
        if (resolveOptions.kind === "pattern" && relative.length === 0)
          return yield* pathError("Function pattern must not be empty", relative);
        const realRoot = yield* fs
          .realPath(configuredRoot)
          .pipe(
            Effect.mapError(() =>
              notFound("Functions root is not present", undefined, configuredRoot),
            ),
          );
        const normalized = relative.replaceAll(/[\\/]/gu, path.sep);
        const lexical = path.resolve(realRoot, normalized);
        if (!isInside(path, realRoot, lexical))
          return yield* pathError("Function path escapes functionsRoot", relative);
        const kind = resolveOptions.kind ?? "file";
        const checkPath = kind === "pattern" ? patternBase(path, normalized) : normalized;
        const checkLexical = path.resolve(realRoot, checkPath);
        if (!isInside(path, realRoot, checkLexical))
          return yield* pathError("Function path escapes functionsRoot", relative);
        const exists = yield* fs
          .exists(checkLexical)
          .pipe(
            Effect.mapError((cause) =>
              pathError("Unable to inspect function path", relative, cause),
            ),
          );
        if (!exists) return yield* notFound("Function path is not present", undefined, relative);
        const realCheck = yield* fs
          .realPath(checkLexical)
          .pipe(
            Effect.mapError((cause) =>
              pathError("Unable to resolve function path", relative, cause),
            ),
          );
        if (!isInside(path, realRoot, realCheck))
          return yield* pathError("Function path symlink escapes functionsRoot", relative);
        const info = yield* fs
          .stat(realCheck)
          .pipe(
            Effect.mapError((cause) =>
              pathError("Unable to inspect function path", relative, cause),
            ),
          );
        if (kind === "file" && info.type !== "File")
          return yield* pathError("Function path must be a file", relative);
        if (kind === "directory" && info.type !== "Directory")
          return yield* pathError("Function path must be a directory", relative);
        const relativeCanonical =
          kind === "pattern"
            ? relative.replaceAll(/[\\/]/gu, path.sep)
            : path.relative(realRoot, realCheck);
        return {
          native: kind === "pattern" ? lexical : realCheck,
          relative: relativeCanonical,
          container: containerPath(relativeCanonical),
          kind,
        } satisfies ContainedPath;
      });

    const resolveFunctionPath = (
      slug: string,
      relative: string,
      resolveOptions: { readonly kind?: "file" | "directory" | "pattern" } = {},
    ) => {
      if (!/^[A-Za-z0-9_-]+$/u.test(slug))
        return Effect.fail(notFound("Function slug is invalid", slug));
      if (path.isAbsolute(relative) || hasLexicalEscape(relative))
        return Effect.fail(pathError("Function path escapes function directory", relative));
      return resolveContained(path.join(slug, relative), resolveOptions);
    };

    const resolveModulePath = (
      base: ContainedPath,
      relative: string,
    ): Effect.Effect<
      ContainedPath,
      FunctionNotFoundError | FunctionPathError,
      FileSystem.FileSystem
    > =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        if (path.isAbsolute(relative) || relative.length === 0)
          return yield* pathError("Function module path is invalid", relative);
        const realRoot = yield* fs
          .realPath(configuredRoot)
          .pipe(
            Effect.mapError(() =>
              notFound("Functions root is not present", undefined, configuredRoot),
            ),
          );
        const validatedBase = yield* resolveContained(base.relative, { kind: "file" });
        const normalized = relative.replaceAll(/[\\/]/gu, path.sep);
        const lexical = path.resolve(path.dirname(validatedBase.native), normalized);
        if (!isInside(path, realRoot, lexical))
          return yield* pathError("Function module path escapes functionsRoot", relative);
        const exists = yield* fs
          .exists(lexical)
          .pipe(
            Effect.mapError((cause) =>
              pathError("Unable to inspect function module", relative, cause),
            ),
          );
        if (!exists) return yield* notFound("Function module is not present", undefined, relative);
        const real = yield* fs
          .realPath(lexical)
          .pipe(
            Effect.mapError((cause) =>
              pathError("Unable to resolve function module", relative, cause),
            ),
          );
        if (!isInside(path, realRoot, real))
          return yield* pathError("Function module symlink escapes functionsRoot", relative);
        const info = yield* fs
          .stat(real)
          .pipe(
            Effect.mapError((cause) =>
              pathError("Unable to inspect function module", relative, cause),
            ),
          );
        if (info.type !== "File")
          return yield* pathError("Function module must be a file", relative);
        const relativeCanonical = path.relative(realRoot, real);
        return {
          native: real,
          relative: relativeCanonical,
          container: containerPath(relativeCanonical),
          kind: "file",
        } satisfies ContainedPath;
      });

    const mount = resolveContained("", { kind: "directory" }).pipe(
      Effect.map(
        (root) =>
          ({
            root: root.native,
            mount: Object.freeze({ source: root.native, target: containerRoot, readOnly: true }),
          }) satisfies FunctionsContainerMapping,
      ),
    );

    return {
      configuredRoot,
      mount,
      resolveContained,
      resolveFunctionPath,
      resolveModulePath,
    } satisfies FunctionsRoot;
  });
