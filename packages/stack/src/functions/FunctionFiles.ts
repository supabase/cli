import { Data, Effect, FileSystem, Path, Predicate, Result, Schema } from "effect";
import * as PlatformError from "effect/PlatformError";

const windowsAbsolutePath = /^[A-Za-z]:\//u;
const importPathPattern =
  /(?:import|export)\s+(?:type\s+)?(?:\{[^{}]+\}|.*?)\s*(?:from)?\s*['"](.*?)['"]|import\(\s*['"](.*?)['"]\)/giu;

export interface FunctionFilesInput {
  readonly projectRoot: string;
  readonly sourceRoot: string;
  readonly entrypoint: string;
  readonly importMap: string;
  readonly staticFiles: ReadonlyArray<string>;
  readonly additionalModuleRoots?: ReadonlyArray<string>;
  readonly skipMissingImportMapTargets?: boolean;
}

export interface FunctionFile {
  readonly hostPath: string;
  /** The lexical path requested by the import map, which can differ from hostPath for symlinks. */
  readonly targetPath: string;
  readonly kind: "file" | "directory";
  readonly externalScope: boolean;
}

export interface FunctionFilesPlan {
  readonly files: ReadonlyArray<FunctionFile>;
  readonly warnings: ReadonlyArray<string>;
  /** Canonical roots that bound ordinary source and import-map traversal. */
  readonly allowedRoots: ReadonlyArray<string>;
}

export class FunctionFilesError extends Data.TaggedError("FunctionFilesError")<{
  readonly message: string;
  readonly reason: "import-not-directory" | "filesystem" | "parse" | "cycle";
  readonly pathname?: string;
  readonly cause?: unknown;
  readonly fsReason?: "not-found" | "not-directory";
}> {}

type Fs = FileSystem.FileSystem;
type P = Path.Path;
type FileCallback = (
  pathname: string,
  contents: Uint8Array,
) => Effect.Effect<void, FunctionFilesError>;
type WarningCallback = (message: string) => Effect.Effect<void, never>;

const slash = (pathname: string) => pathname.replaceAll("\\", "/");
const isDenoConfigFile = (pathname: string) => {
  const name = pathname.slice(pathname.lastIndexOf("/") + 1).toLowerCase();
  return name === "deno.json" || name === "deno.jsonc";
};
const contained = (path: P, root: string, candidate: string) => {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relativePath === "" ||
    (!path.isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`))
  );
};
const containedInAny = (path: P, roots: ReadonlyArray<string>, candidate: string) =>
  roots.some((root) => contained(path, root, candidate));
const isNotFound = (error: unknown) =>
  error instanceof FunctionFilesError && error.fsReason === "not-found";
const isNotDirectory = (error: unknown) =>
  error instanceof FunctionFilesError && error.fsReason === "not-directory";

const stripJsonComments = (contents: string) => {
  const src = contents.replace(/^\uFEFF/u, "");
  const out: string[] = [];
  let pendingComma = -1;
  let index = 0;
  while (index < src.length) {
    const char = src.charAt(index);
    if (char === '"') {
      pendingComma = -1;
      out.push(char);
      index += 1;
      while (index < src.length) {
        const next = src.charAt(index++);
        out.push(next);
        if (next === "\\" && index < src.length) out.push(src.charAt(index++));
        else if (next === '"') break;
      }
      continue;
    }
    if (char === "/" && src.charAt(index + 1) === "/") {
      index += 2;
      while (index < src.length && src.charAt(index) !== "\n") index += 1;
      continue;
    }
    if (char === "/" && src.charAt(index + 1) === "*") {
      index += 2;
      while (index < src.length && !(src.charAt(index) === "*" && src.charAt(index + 1) === "/"))
        index += 1;
      index += 2;
      continue;
    }
    if (char === ",") {
      pendingComma = out.length;
      out.push(char);
    } else if (char === "}" || char === "]") {
      if (pendingComma >= 0) {
        out[pendingComma] = "";
        pendingComma = -1;
      }
      out.push(char);
    } else {
      out.push(char);
      if (!" \t\n\r".includes(char)) pendingComma = -1;
    }
    index += 1;
  }
  return out.join("");
};
const resolveImportTarget = (path: P, jsonPath: string, target: string) => {
  if (target.startsWith("/")) return target;
  try {
    if (new URL(target).protocol.length > 0) return target;
  } catch {
    // Relative path.
  }
  const resolved = slash(path.join(path.dirname(jsonPath), target));
  const normalized =
    resolved.startsWith("/") ||
    windowsAbsolutePath.test(resolved) ||
    resolved.startsWith("./") ||
    resolved.startsWith("../")
      ? resolved
      : `./${resolved}`;
  return target.endsWith("/") && !normalized.endsWith("/") ? `${normalized}/` : normalized;
};
const isRemote = (target: string) => {
  if (target.startsWith("/") || windowsAbsolutePath.test(target)) return false;
  try {
    return new URL(target).protocol.length > 0;
  } catch {
    return false;
  }
};
const readStringMap = (input: unknown, fieldName: string): Record<string, string> => {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error(`failed to parse import map: expected ${fieldName} to be an object`);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string")
      throw new Error(`failed to parse import map: expected ${fieldName}.${key} to be a string`);
    result[key] = value;
  }
  return result;
};

class ImportMapFile {
  constructor(
    readonly imports: Record<string, string> = {},
    readonly scopes: Record<string, Record<string, string>> = {},
    readonly importMapReference = "",
  ) {}
  static fromUnknown(input: unknown) {
    const value =
      typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    const scopes: Record<string, Record<string, string>> = {};
    const rawScopes = value["scopes"];
    if (rawScopes !== undefined) {
      if (typeof rawScopes !== "object" || rawScopes === null || Array.isArray(rawScopes))
        throw new Error("failed to parse import map: expected scopes to be an object");
      for (const [key, scope] of Object.entries(rawScopes))
        scopes[key] = readStringMap(scope, `scopes.${key}`);
    }
    return new ImportMapFile(
      readStringMap(value["imports"], "imports"),
      scopes,
      typeof value["importMap"] === "string" ? value["importMap"] : "",
    );
  }
  get isReference() {
    return (
      Object.keys(this.imports).length === 0 &&
      Object.keys(this.scopes).length === 0 &&
      this.importMapReference.length > 0
    );
  }
  resolve(path: P, jsonPath: string) {
    return new ImportMapFile(
      Object.fromEntries(
        Object.entries(this.imports).map(([key, value]) => [
          key,
          resolveImportTarget(path, jsonPath, value),
        ]),
      ),
      Object.fromEntries(
        Object.entries(this.scopes).map(([key, scope]) => [
          resolveImportTarget(path, jsonPath, key),
          Object.fromEntries(
            Object.entries(scope).map(([name, value]) => [
              name,
              resolveImportTarget(path, jsonPath, value),
            ]),
          ),
        ]),
      ),
      this.importMapReference,
    );
  }
}
const hasErrnoCode = (value: unknown): value is { readonly code?: unknown } =>
  typeof value === "object" && value !== null && "code" in value;

const mapFsError = (pathname: string, cause: unknown) => {
  const fsReason =
    cause instanceof PlatformError.PlatformError &&
    cause.reason instanceof PlatformError.SystemError
      ? Predicate.isTagged(cause.reason, "NotFound")
        ? "not-found"
        : hasErrnoCode(cause.reason.cause) && cause.reason.cause.code === "ENOTDIR"
          ? "not-directory"
          : undefined
      : undefined;
  return new FunctionFilesError({
    message: `failed to access file: ${pathname}`,
    reason: "filesystem",
    pathname,
    cause,
    ...(fsReason === undefined ? {} : { fsReason }),
  });
};
const realPath = (fs: Fs, pathname: string) =>
  fs.realPath(pathname).pipe(Effect.mapError((cause) => mapFsError(pathname, cause)));
const fileStat = (fs: Fs, pathname: string) =>
  fs.stat(pathname).pipe(Effect.mapError((cause) => mapFsError(pathname, cause)));
const readDirectory = (fs: Fs, pathname: string) =>
  fs
    .readDirectory(pathname, { recursive: true })
    .pipe(Effect.mapError((cause) => mapFsError(pathname, cause)));
const readBytes = (fs: Fs, pathname: string) =>
  fs.readFile(pathname).pipe(Effect.mapError((cause) => mapFsError(pathname, cause)));
const loadImportMap = (
  fs: Fs,
  path: P,
  pathname: string,
  onRead: FileCallback | undefined,
  seen: ReadonlySet<string>,
): Effect.Effect<ImportMapFile, FunctionFilesError> =>
  Effect.gen(function* () {
    const resolvedPath = path.resolve(pathname);
    if (seen.has(resolvedPath))
      return yield* new FunctionFilesError({
        message: `cyclic import map reference: ${pathname}`,
        reason: "cycle",
        pathname,
      });
    const contents = yield* readBytes(fs, pathname);
    if (onRead !== undefined) yield* onRead(pathname, contents);
    const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
      stripJsonComments(new TextDecoder().decode(contents)),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new FunctionFilesError({
            message: `failed to parse import map: ${pathname}`,
            reason: "parse",
            pathname,
            cause,
          }),
      ),
    );
    const importMap = yield* Effect.try({
      try: () => ImportMapFile.fromUnknown(parsed).resolve(path, slash(pathname)),
      catch: (cause) =>
        new FunctionFilesError({
          message: `failed to parse import map: ${pathname}`,
          reason: "parse",
          pathname,
          cause,
        }),
    });
    const nextSeen = new Set(seen).add(resolvedPath);
    return isDenoConfigFile(pathname) && importMap.isReference
      ? yield* loadImportMap(
          fs,
          path,
          path.join(path.dirname(pathname), importMap.importMapReference),
          onRead,
          nextSeen,
        )
      : importMap;
  });
const substitute = (mappings: Readonly<Record<string, string>>, specifier: string) => {
  let match: [string, string] | undefined;
  for (const entry of Object.entries(mappings)) {
    const [prefix, value] = entry;
    if (prefix.length === 0) continue;
    if (prefix.endsWith("/")) {
      if (!value.endsWith("/") || !specifier.startsWith(prefix)) continue;
    } else if (specifier !== prefix) continue;
    if (match === undefined || prefix.length > match[0].length) match = entry;
  }
  return match === undefined ? undefined : match[1] + specifier.slice(match[0].length);
};
const resolveSpecifier = (map: ImportMapFile, current: string, specifier: string) => {
  let resolved = specifier;
  let substituted = false;
  let scoped: Readonly<Record<string, string>> | undefined;
  let length = -1;
  for (const [name, value] of Object.entries(map.scopes))
    if (
      (name === current || (name.endsWith("/") && current.startsWith(name))) &&
      name.length > length
    ) {
      scoped = value;
      length = name.length;
    }
  const scopedResolved = scoped === undefined ? undefined : substitute(scoped, resolved);
  if (scopedResolved !== undefined) {
    resolved = scopedResolved;
    substituted = true;
  }
  if (!substituted) {
    const globalResolved = substitute(map.imports, resolved);
    if (globalResolved !== undefined) {
      resolved = globalResolved;
      substituted = true;
    }
  }
  return { path: resolved, substituted };
};

const walkImports = (
  fs: Fs,
  path: P,
  map: ImportMapFile,
  source: string,
  roots: ReadonlyArray<string>,
  displayRoot: string,
  onFile: FileCallback,
  onWarning: WarningCallback,
): Effect.Effect<void, FunctionFilesError> =>
  Effect.gen(function* () {
    type Loaded =
      | { readonly _tag: "loaded"; readonly contents: Uint8Array }
      | { readonly _tag: "outside" };
    const seen = new Set<string>();
    const queue = [slash(source)];
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      const loaded = yield* realPath(fs, path.resolve(current)).pipe(
        Effect.flatMap((currentPath) =>
          containedInAny(path, roots, currentPath)
            ? readBytes(fs, currentPath).pipe(
                Effect.map((contents): Loaded => ({ _tag: "loaded", contents })),
              )
            : Effect.succeed<Loaded>({ _tag: "outside" }),
        ),
        Effect.result,
      );
      if (Result.isFailure(loaded)) {
        const error = loaded.failure;
        if (isNotFound(error)) {
          yield* onWarning(
            `WARN: failed to read file: open ${slash(path.relative(displayRoot, current))}: no such file or directory\n`,
          );
          continue;
        }
        if (isNotDirectory(error))
          return yield* new FunctionFilesError({
            message: `failed to read file: open ${slash(path.relative(displayRoot, current))}: not a directory`,
            reason: "import-not-directory",
            pathname: current,
            cause: error,
          });
        return yield* error;
      }
      if (loaded.success._tag === "outside") {
        yield* onWarning(`WARN: Skipping import path outside source root: ${current}\n`);
        continue;
      }
      const { contents } = loaded.success;
      yield* onFile(current, contents);
      importPathPattern.lastIndex = 0;
      for (const match of new TextDecoder().decode(contents).matchAll(importPathPattern)) {
        const raw = match[1] ?? match[2];
        if (raw === undefined) continue;
        let { path: modulePath, substituted } = resolveSpecifier(map, slash(current), raw.trim());
        modulePath = slash(modulePath);
        if (!modulePath.slice(modulePath.lastIndexOf("/") + 1).includes(".")) continue;
        if (
          !modulePath.startsWith("./") &&
          !modulePath.startsWith("../") &&
          !modulePath.startsWith("/") &&
          !windowsAbsolutePath.test(modulePath)
        )
          continue;
        if (!substituted && (modulePath.startsWith("./") || modulePath.startsWith("../")))
          modulePath = slash(path.join(path.dirname(current), modulePath));
        const resolvedModule = path.resolve(modulePath);
        const containmentPath = yield* realPath(fs, resolvedModule).pipe(
          Effect.orElseSucceed(() => resolvedModule),
        );
        if (!containedInAny(path, roots, containmentPath)) {
          yield* onWarning(`WARN: Skipping import path outside source root: ${modulePath}\n`);
          continue;
        }
        queue.push(slash(resolvedModule));
      }
    }
  });

const hasGlob = (pattern: string) =>
  pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
const globBase = (path: P, pattern: string) => {
  const normalized = slash(pattern);
  if (!hasGlob(normalized)) return path.dirname(normalized);
  const stable: string[] = [];
  for (const part of normalized.split("/")) {
    if (part.includes("*") || part.includes("?") || part.includes("[")) break;
    stable.push(part);
  }
  return stable.length === 0 ? "." : stable.join("/");
};
const globRegexp = (pattern: string) => {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === undefined) continue;
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
};
const expandStatic = (
  fs: Fs,
  path: P,
  pattern: string,
): Effect.Effect<ReadonlyArray<string>, FunctionFilesError> =>
  Effect.gen(function* () {
    if (!hasGlob(pattern)) {
      yield* fileStat(fs, pattern);
      return [pattern];
    }
    const candidates = yield* readDirectory(fs, globBase(path, pattern));
    const matcher = globRegexp(slash(path.resolve(pattern)));
    const matches = candidates
      .map((candidate) => path.resolve(globBase(path, pattern), candidate))
      .filter((candidate) => matcher.test(slash(candidate)));
    if (matches.length === 0)
      return yield* new FunctionFilesError({
        message: `no files matched pattern: ${pattern}`,
        reason: "filesystem",
        pathname: pattern,
      });
    return matches;
  });

const plan = (
  input: FunctionFilesInput,
): Effect.Effect<FunctionFilesPlan, FunctionFilesError, Fs | P> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* realPath(fs, path.resolve(input.projectRoot));
    const sourceRoot = yield* realPath(fs, path.resolve(input.sourceRoot));
    const additionalRoots = yield* Effect.forEach(
      input.additionalModuleRoots ?? [],
      (root) => realPath(fs, path.resolve(root)).pipe(Effect.orElseSucceed(() => undefined)),
      { concurrency: 4 },
    );
    const moduleRoots = [
      sourceRoot,
      ...additionalRoots.filter((root): root is string => root !== undefined),
    ];
    const importMapRoots = [sourceRoot];
    if (input.importMap.length > 0) {
      const mapPath = yield* realPath(fs, path.resolve(input.importMap));
      if (!contained(path, sourceRoot, mapPath)) importMapRoots.push(path.dirname(mapPath));
    }
    const files: FunctionFile[] = [];
    const warnings: string[] = [];
    const addImportMapFile = (pathname: string, _contents: Uint8Array) =>
      Effect.gen(function* () {
        const canonicalPath = yield* realPath(fs, path.resolve(pathname));
        if (!contained(path, sourceRoot, canonicalPath)) {
          const root = path.dirname(canonicalPath);
          if (!importMapRoots.includes(root)) importMapRoots.push(root);
        }
        yield* add(importMapRoots, pathname).pipe(Effect.asVoid);
      });
    const add = (
      roots: ReadonlyArray<string>,
      pathname: string,
      externalScope = false,
      targetPath = pathname,
    ): Effect.Effect<
      { readonly hostPath: string; readonly contained: boolean },
      FunctionFilesError
    > =>
      Effect.gen(function* () {
        const hostPath = yield* realPath(fs, path.resolve(pathname));
        if (!containedInAny(path, roots, hostPath)) return { hostPath, contained: false };
        const kind = (yield* fileStat(fs, pathname)).type === "Directory" ? "directory" : "file";
        files.push({ hostPath, targetPath: slash(targetPath), kind, externalScope });
        return { hostPath, contained: true };
      });
    const map =
      input.importMap.length > 0
        ? yield* loadImportMap(fs, path, input.importMap, addImportMapFile, new Set())
        : new ImportMapFile();
    yield* walkImports(
      fs,
      path,
      map,
      input.entrypoint,
      moduleRoots,
      input.sourceRoot,
      (pathname, _contents) => add(moduleRoots, pathname).pipe(Effect.asVoid),
      (message) =>
        Effect.sync(() => {
          warnings.push(message);
        }),
    );
    for (const [target, isScopeTarget] of [
      ...Object.values(map.imports).map((target) => [target, false] as const),
      ...Object.values(map.scopes).flatMap((scope) =>
        Object.values(scope).map((target) => [target, true] as const),
      ),
    ]) {
      if (isRemote(target)) continue;
      yield* Effect.gen(function* () {
        const result = yield* add(importMapRoots, target);
        const info = yield* fileStat(fs, target);
        if (!result.contained && isScopeTarget) {
          files.push({
            hostPath: result.hostPath,
            targetPath: slash(target),
            kind: info.type === "Directory" ? "directory" : "file",
            externalScope: true,
          });
          warnings.push(
            `WARN: Mounting import map scope target outside the project root: ${result.hostPath}\n`,
          );
        }
        if (info.type === "Directory" || !result.contained) return;
        yield* walkImports(
          fs,
          path,
          map,
          target,
          importMapRoots,
          input.sourceRoot,
          (pathname, _contents) => add(importMapRoots, pathname).pipe(Effect.asVoid),
          (message) =>
            Effect.sync(() => {
              warnings.push(message);
            }),
        );
      }).pipe(
        Effect.catch((error) => {
          if (isNotDirectory(error))
            return Effect.sync(() => {
              warnings.push(
                `WARN: Skipping import map target that is not a directory: ${target}\n`,
              );
            });
          if (input.skipMissingImportMapTargets === true && isNotFound(error))
            return Effect.sync(() => {
              warnings.push(`WARN: Skipping missing import map target: ${target}\n`);
            });
          return Effect.fail(error);
        }),
      );
    }
    for (const pattern of input.staticFiles) {
      const matches = yield* expandStatic(fs, path, pattern).pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
      );
      for (const pathname of matches) {
        if ((yield* fileStat(fs, pathname)).type === "Directory")
          return yield* new FunctionFilesError({
            message: `file path is a directory: ${pathname}`,
            reason: "filesystem",
            pathname,
          });
        yield* add([sourceRoot], pathname).pipe(Effect.asVoid);
      }
    }
    return { files, warnings, allowedRoots: [...new Set(importMapRoots)] };
  });

/** Discovers function files while requiring the caller's platform FileSystem and Path services. */
export const planFunctionFiles = (
  input: FunctionFilesInput,
): Effect.Effect<FunctionFilesPlan, FunctionFilesError, Fs | P> => plan(input);
