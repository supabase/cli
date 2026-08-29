import { Effect, FileSystem, Path } from "effect";
import type {
  FunctionSecret,
  MaterializedFunctionSettings,
  FunctionSettings,
} from "../model/capabilities/functions.ts";
import { FunctionSettingsDefaults } from "../model/capabilities/functions.ts";
import type {
  ActivationResult,
  BackendEndpoint,
  GatewayRoute,
  GatewayRouteRequest,
} from "../gateway/Gateway.ts";
import { GatewayRouteNotFoundError } from "../gateway/Gateway.ts";
import { GatewayActivationError } from "../public/Errors.ts";
import {
  FunctionNotFoundError,
  FunctionPathError,
  type ContainedPath,
  type FunctionsContainerMapping,
  type FunctionsRoot,
} from "./FunctionsRoot.ts";

export { FunctionNotFoundError, FunctionPathError } from "./FunctionsRoot.ts";

export interface FunctionInvocationPath {
  readonly native: string;
  readonly container: string;
}

export interface FunctionInvocationRoot {
  readonly native: string;
  readonly container: string;
  readonly mount: FunctionsContainerMapping["mount"];
}

export interface FunctionInvocation {
  readonly slug: string;
  readonly verifyJwt: boolean;
  readonly entrypoint: FunctionInvocationPath;
  readonly importMap?: FunctionInvocationPath;
  readonly staticPatterns: ReadonlyArray<FunctionInvocationPath>;
  readonly env: Readonly<Record<string, FunctionSecret>>;
  readonly root: FunctionInvocationRoot;
}

export interface FunctionDiscoveryOptions {
  readonly root: FunctionsRoot;
  readonly settings: MaterializedFunctionSettings;
  readonly globalEnv?: Readonly<Record<string, FunctionSecret>>;
}

export interface FunctionDiscovery {
  readonly discover: (
    slug: string,
  ) => Effect.Effect<FunctionInvocation, FunctionNotFoundError | FunctionPathError>;
}

const functionSlugPattern = /^[A-Za-z0-9_-]+$/u;
const notFound = (message: string, slug?: string) =>
  new FunctionNotFoundError({ message, ...(slug === undefined ? {} : { slug }) });

const pathFailure = (message: string, path?: string, cause?: unknown) =>
  new FunctionPathError({
    message,
    ...(path === undefined ? {} : { path }),
    ...(cause === undefined ? {} : { cause }),
  });

const makeInvocation = (
  root: FunctionsRoot,
  options: FunctionDiscoveryOptions,
  slug: string,
  settings: FunctionSettings,
): Effect.Effect<
  FunctionInvocation,
  FunctionNotFoundError | FunctionPathError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    if (!settings.enabled) return yield* notFound("Function is disabled", slug);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const canonicalRoot = yield* root.resolveContained("", { kind: "directory" });
    const functionDirectory = yield* root.resolveFunctionPath(slug, "", { kind: "directory" });

    const validateTree = (
      directory: string,
      relativeDirectory: string,
      seen: Set<string>,
    ): Effect.Effect<
      void,
      FunctionNotFoundError | FunctionPathError,
      FileSystem.FileSystem | Path.Path
    > =>
      Effect.gen(function* () {
        const canonical = yield* fs
          .realPath(directory)
          .pipe(
            Effect.mapError((cause) =>
              pathFailure("Function directory cannot be resolved", directory, cause),
            ),
          );
        if (seen.has(canonical)) return;
        seen.add(canonical);
        const entries = yield* fs
          .readDirectory(directory)
          .pipe(
            Effect.mapError((cause) =>
              pathFailure("Function directory cannot be read", directory, cause),
            ),
          );
        for (const entry of entries) {
          const child = path.join(directory, entry);
          const relative = path.join(relativeDirectory, entry);
          const info = yield* fs
            .stat(child)
            .pipe(
              Effect.mapError((cause) =>
                pathFailure("Function path cannot be inspected", relative, cause),
              ),
            );
          yield* root.resolveContained(relative, {
            kind: info.type === "Directory" ? "directory" : "file",
          });
          if (info.type === "Directory") yield* validateTree(child, relative, seen);
        }
      });

    yield* validateTree(functionDirectory.native, functionDirectory.relative, new Set());
    const shared = yield* root
      .resolveContained("_shared", { kind: "directory" })
      .pipe(Effect.catchTag("FunctionNotFoundError", () => Effect.as(Effect.void, undefined)));
    if (shared !== undefined) yield* validateTree(shared.native, shared.relative, new Set());

    const entrypointRelative = settings.entrypoint.length > 0 ? settings.entrypoint : "index.ts";
    const entrypoint = yield* root
      .resolveFunctionPath(slug, entrypointRelative, { kind: "file" })
      .pipe(
        Effect.catchTag("FunctionNotFoundError", () =>
          Effect.fail(notFound("Function entrypoint is not present", slug)),
        ),
      );

    let importMap: ContainedPath | undefined;
    const explicitImportMap = settings.import_map.length > 0 ? settings.import_map : undefined;
    if (explicitImportMap !== undefined) {
      importMap = yield* root
        .resolveFunctionPath(slug, explicitImportMap, { kind: "file" })
        .pipe(
          Effect.catchTag("FunctionNotFoundError", () =>
            Effect.fail(pathFailure("Function import map is not present", explicitImportMap)),
          ),
        );
    } else {
      for (const candidate of ["deno.json", "deno.jsonc"]) {
        const resolved = yield* root
          .resolveFunctionPath(slug, candidate, { kind: "file" })
          .pipe(Effect.catchTag("FunctionNotFoundError", () => Effect.as(Effect.void, undefined)));
        if (resolved !== undefined) {
          importMap = resolved;
          break;
        }
      }
    }

    const staticPatterns: ContainedPath[] = [];
    for (const pattern of settings.static_files) {
      if (pattern.length === 0)
        return yield* pathFailure("Function static pattern must not be empty", pattern);
      const resolved = yield* root.resolveFunctionPath(slug, pattern, { kind: "pattern" });
      staticPatterns.push(resolved);
    }

    const env = Object.freeze(Object.assign({}, options.globalEnv ?? {}, settings.env));
    const nativeRoot = canonicalRoot.native;
    const mount = Object.freeze({
      source: nativeRoot,
      target: canonicalRoot.container,
      readOnly: true,
    });
    const containerRoot = mount.target;
    return Object.freeze({
      slug,
      verifyJwt: settings.verify_jwt,
      entrypoint: Object.freeze({ native: entrypoint.native, container: entrypoint.container }),
      ...(importMap === undefined
        ? {}
        : {
            importMap: Object.freeze({ native: importMap.native, container: importMap.container }),
          }),
      staticPatterns: Object.freeze(
        staticPatterns.map((value) =>
          Object.freeze({ native: value.native, container: value.container }),
        ),
      ),
      env,
      root: Object.freeze({
        native: nativeRoot,
        container: containerRoot,
        mount,
      }),
    }) satisfies FunctionInvocation;
  });

export const makeFunctionDiscovery = (
  options: FunctionDiscoveryOptions,
): Effect.Effect<FunctionDiscovery, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const discover = (slug: string) => {
      if (!functionSlugPattern.test(slug) || slug === "_shared")
        return Effect.fail(notFound("Function slug is invalid", slug));
      const settings = options.settings[slug] ?? FunctionSettingsDefaults;
      return makeInvocation(options.root, options, slug, settings).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    };
    return { discover } satisfies FunctionDiscovery;
  });

export const discoverFunction = (
  root: FunctionsRoot,
  slug: string,
  settings: MaterializedFunctionSettings,
): Effect.Effect<
  FunctionInvocation,
  FunctionNotFoundError | FunctionPathError,
  FileSystem.FileSystem | Path.Path
> =>
  makeFunctionDiscovery({ root, settings }).pipe(
    Effect.flatMap((discovery) => discovery.discover(slug)),
  );

const functionSlugFromRequest = (request: GatewayRouteRequest): string | undefined => {
  const path = request.path.split("?", 1)[0] ?? request.path;
  const match = /^\/functions\/v1\/([^/]+)(?:\/.*)?$/u.exec(path);
  return match?.[1];
};

/** Remove the public Functions prefix before forwarding to Edge Runtime. */
export const rewriteFunctionRequestPath = (requestPath: string): string => {
  const queryIndex = requestPath.indexOf("?");
  const pathname = queryIndex < 0 ? requestPath : requestPath.slice(0, queryIndex);
  const query = queryIndex < 0 ? "" : requestPath.slice(queryIndex);
  const prefix = "/functions/v1";
  if (!pathname.startsWith(`${prefix}/`) && pathname !== prefix) return requestPath;
  const rewritten = pathname.slice(prefix.length) || "/";
  return `${rewritten}${query}`;
};

export interface FunctionsGatewayRouteOptions {
  readonly dispatch: (
    invocation: FunctionInvocation,
    activation: ActivationResult,
  ) => Effect.Effect<BackendEndpoint, GatewayActivationError>;
}

export const makeFunctionsGatewayRoute = (
  discovery: FunctionDiscovery,
  options: FunctionsGatewayRouteOptions,
): GatewayRoute => ({
  capability: "functions",
  match: (request) => functionSlugFromRequest(request) !== undefined,
  prepare: (request) => {
    const slug = functionSlugFromRequest(request);
    if (slug === undefined)
      return Effect.fail(new GatewayRouteNotFoundError({ message: "Function route not found" }));
    return discovery.discover(slug).pipe(
      Effect.map((invocation) => ({
        resolveBackend: (activation: ActivationResult) => options.dispatch(invocation, activation),
        upstreamPath: (request: GatewayRouteRequest) => rewriteFunctionRequestPath(request.path),
      })),
      Effect.catchTags({
        FunctionNotFoundError: () =>
          Effect.fail(new GatewayRouteNotFoundError({ message: "Function route not found" })),
        FunctionPathError: (error) =>
          Effect.fail(
            new GatewayActivationError({ message: "Function path is invalid", cause: error }),
          ),
      }),
    );
  },
});
