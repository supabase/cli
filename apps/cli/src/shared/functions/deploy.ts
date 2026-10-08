import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { URL } from "node:url";
import {
  FunctionResponse_Output,
  operationDefinitions,
  SupabaseApiInputError,
  type ApiClient,
} from "@supabase/api/effect";
import {
  inferFunctionsManifest,
  type ResolvedFunctionConfig as ManifestFunctionConfig,
} from "@supabase/config/effect";
import {
  Cause,
  Clock,
  Config,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  type PlatformError,
  Schema,
} from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { promptYesNo } from "../../command-internal/prompt-yes-no.ts";
import { bitbucketCloneDir } from "../../command-internal/bitbucket-pipeline.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../output/errors.ts";
import { Output } from "../output/output.service.ts";
import { bold } from "../../command-internal/colors.ts";
import { supabaseEnvStringWithProjectFallback } from "../../command-internal/supabase-env.ts";
import { findGitRootPath } from "../git/git-root.ts";
import {
  mutuallyExclusiveFlagsMessage,
  explicitBooleanLongFlag,
  hasExplicitLongFlag,
  lastExplicitLongFlagValue,
} from "../cli/flag-groups.ts";
import {
  edgeRuntimeImage,
  FUNCTIONS_DEPLOY_BUNDLER_MUTEX_GROUP,
  invalidFunctionSlugDetail,
  validateFunctionSlugMessage,
} from "./functions.shared.ts";
import { slimImagesEnabled } from "../services/slim-images.ts";
import {
  ConflictingFunctionDeployFlagsError,
  FunctionDeployCancelledError,
  FunctionDeployError,
  FunctionImportMapSyntaxError,
  FunctionImportNotDirectoryError,
  InvalidFunctionDeploySlugError,
  NoFunctionsToDeployError,
} from "./deploy.errors.ts";
import {
  buildFunctionsDockerRunArgs,
  edgeRuntimeCacheVolume,
  ensureDockerNamedVolume,
  ensureDockerNetwork,
  isDockerRunning,
  nativePlatformFailure,
  resolveDockerNetworkMode,
  resolveEdgeRuntimeVersion,
  resolveFunctionsDockerImage,
  runChildProcess,
  toDockerPath,
  toSlash,
} from "./functions-docker.ts";
import { loadFunctionsCliConfig, type FunctionsLocalConfigLoader } from "./functions-config.ts";
import { FunctionsApiStatusError, FunctionsApiTransportError } from "./functions-api.errors.ts";

const COMPRESSED_ESZIP_MAGIC = "EZBR";
const DEPLOY_RATE_LIMIT_MAX_RETRIES = 8;
const SUPABASE_FUNCTIONS_DIR = "supabase/functions";
const IMPORT_MAP_GUIDE_URL = "https://supabase.com/docs/guides/functions/import-maps";
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\//;
const importPathPattern =
  /(?:import|export)\s+(?:type\s+)?(?:{[^{}]+}|.*?)\s*(?:from)?\s*['"](.*?)['"]|import\(\s*['"](.*?)['"]\)/gi;

export function shouldChmodBundleOutputDirectory(platform: NodeJS.Platform) {
  return platform !== "win32";
}

interface FunctionsDeployFlags {
  readonly functionNames: ReadonlyArray<string>;
  readonly projectRef: Option.Option<string>;
  readonly noVerifyJwt: boolean;
  readonly useApi: boolean;
  readonly importMap: Option.Option<string>;
  readonly prune: boolean;
  readonly jobs: Option.Option<number>;
  readonly useDocker: boolean;
  readonly legacyBundle: boolean;
}

interface DeployFunctionsDependencies<ResolveError, ResolveRequirements> {
  readonly api: ApiClient;
  readonly cwd: string;
  readonly flagCwd: string;
  readonly projectRoot: string;
  readonly supabaseDir: string;
  readonly dashboardUrl: string;
  /**
   * The CLI injects `functionsLocalConfigLoader` so this file never imports the
   * command tree directly — see {@link FunctionsLocalConfigLoader}.
   */
  readonly localConfigLoader: FunctionsLocalConfigLoader;
  readonly yes?: boolean;
  readonly rawArgs: ReadonlyArray<string>;
  readonly edgeRuntimeVersion: string;
  readonly resolveProjectRef: (
    projectRef: Option.Option<string>,
  ) => Effect.Effect<string, ResolveError, ResolveRequirements>;
  /**
   * Optional shell-specific styling hooks. All default to identity (plain text); keeping them
   * injected keeps this shared module free of CLI-specific rendering.
   * - `styleIdentifier`: the project ref in the stdout success line.
   * - `styleEmphasis`: the slug in the stderr `Bundling Function:` line and the functions dir in
   *   the no-functions error.
   * - `styleWarning`: the `WARNING:` token on the "Docker is not running" fallback line.
   */
  readonly styleIdentifier?: (text: string) => string;
  readonly styleEmphasis?: (text: string) => string;
  readonly styleWarning?: (text: string) => string;
}

export interface ResolvedDeployFunctionConfig {
  readonly slug: string;
  readonly enabled: boolean;
  readonly verifyJwt?: boolean;
  readonly entrypoint: string;
  readonly importMap: string;
  readonly staticFiles: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

interface SourceDeployMetadata {
  readonly name: string;
  readonly verify_jwt?: boolean;
  readonly entrypoint_path: string;
  readonly import_map_path: string;
  readonly static_patterns: ReadonlyArray<string>;
}

interface BundledDeployMetadata {
  readonly name: string;
  readonly verify_jwt?: boolean;
  readonly entrypoint_path: string;
  readonly import_map_path?: string;
  readonly static_patterns?: ReadonlyArray<string>;
  readonly sha256: string;
}

interface BundledFunction {
  readonly slug: string;
  readonly metadata: BundledDeployMetadata;
  readonly body: Uint8Array;
}

type RemoteFunction = typeof FunctionResponse_Output.Type;
type DeployFunctionResponse = typeof operationDefinitions.v1DeployAFunction.outputSchema.Type;
type BulkUpdateFunction =
  (typeof operationDefinitions.v1BulkUpdateFunctions.inputSchema.Type.body)[number];
const nullableOptionalFunctionListFields = new Set([
  "verify_jwt",
  "import_map",
  "entrypoint_path",
  "ezbr_sha256",
]);
const nullableOptionalDeployFunctionFields = new Set([
  ...nullableOptionalFunctionListFields,
  "import_map_path",
]);
const defaultManifestFunctionConfig: ManifestFunctionConfig = {
  enabled: true,
  verify_jwt: true,
  import_map: "",
  entrypoint: "",
  static_files: [],
  env: {},
};

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeFunctionListResponseSchema = Schema.decodeUnknownEffect(
  Schema.Array(FunctionResponse_Output),
);
const decodeDeployFunctionResponseSchema = Schema.decodeUnknownEffect(
  operationDefinitions.v1DeployAFunction.outputSchema,
);

function omitNullableFields(value: unknown, fields: ReadonlySet<string>) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).filter(([key, field]) => field !== null || !fields.has(key)),
  );
}

function decodeDeployFunctionResponse(
  body: string,
): Effect.Effect<DeployFunctionResponse, Schema.SchemaError> {
  return decodeJson(body).pipe(
    Effect.flatMap((value) =>
      decodeDeployFunctionResponseSchema(
        omitNullableFields(value, nullableOptionalDeployFunctionFields),
      ),
    ),
  );
}

function decodeFunctionListResponse(
  body: string,
): Effect.Effect<ReadonlyArray<RemoteFunction>, Schema.SchemaError> {
  return decodeJson(body).pipe(
    Effect.flatMap((value) =>
      decodeFunctionListResponseSchema(
        Array.isArray(value)
          ? value.map((item) => omitNullableFields(item, nullableOptionalFunctionListFields))
          : value,
      ),
    ),
  );
}

// Formats a raw response body for an unexpected-status error message: re-stringifies JSON so the
// message stays byte-identical to a parsed-then-stringified body, falling back to raw text
// otherwise.
function formatUnexpectedStatusBody(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

function mapTransportError(
  prefix: string,
  error: unknown,
): FunctionsApiTransportError | SupabaseApiInputError | HttpBody.HttpBodyError {
  // The request mixes user input with CLI-generated bundle metadata. Preserve
  // validation/build failures so their provenance is not inferred from text.
  if (error instanceof SupabaseApiInputError || error instanceof HttpBody.HttpBodyError) {
    return error;
  }

  if (HttpClientError.isHttpClientError(error)) {
    const description = error.reason.description ?? error.reason._tag;
    return new FunctionsApiTransportError({ message: `${prefix}: ${description}` });
  }

  if (error instanceof Error) {
    return new FunctionsApiTransportError({ message: `${prefix}: ${error.message}` });
  }

  return new FunctionsApiTransportError({ message: `${prefix}: ${String(error)}` });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnKey(value: Readonly<Record<string, unknown>> | undefined, key: string) {
  return value !== undefined && Object.prototype.hasOwnProperty.call(value, key);
}

export function rawFunctionConfigRecord(
  document: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const functions = document?.["functions"];
  if (!isRecord(functions)) {
    return {};
  }

  const configs: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [slug, config] of Object.entries(functions)) {
    if (isRecord(config)) {
      configs[slug] = config;
    }
  }
  return configs;
}

function validateDeploySlug(slug: string): Effect.Effect<void, InvalidFunctionDeploySlugError> {
  if (validateFunctionSlugMessage(slug) === undefined) {
    return Effect.void;
  }

  return Effect.fail(new InvalidFunctionDeploySlugError({ message: invalidFunctionSlugDetail }));
}

function isDenoConfigFile(path: Path.Path, pathname: string) {
  const name = path.basename(pathname).toLowerCase();
  return name === "deno.json" || name === "deno.jsonc";
}

/**
 * Presence-based `Option.some(value)` when `--<flagName>` was passed
 * explicitly after `commandPath`;
 * `Option.none()` otherwise. Used only by `deployFunctions`'s
 * `--no-verify-jwt` override below — kept private per this file's own
 * "used by one command only -> keep it in the command's own directory" rule.
 */
function explicitBooleanFlag(
  rawArgs: ReadonlyArray<string>,
  commandPath: ReadonlyArray<string>,
  flagName: string,
  value: boolean,
) {
  return hasExplicitLongFlag(rawArgs, commandPath, flagName) ? Option.some(value) : Option.none();
}

/**
 * Must stay in sync with `CLI_WORKDIR_LABEL`
 * (`command-internal/docker-ids.ts:95`) — same string literal, kept as a
 * separate copy here rather than imported so `shared/` does not depend on the
 * command tree. Read back by `cleanupStartSecrets` so a later
 * `stop`/`rollbackStart` can reclaim this container's staged-secret
 * directory using its OWN workdir rather than the caller's cwd.
 */
export const dockerWorkdirLabel = "com.supabase.cli.workdir";
/**
 * The eszip bundler container receives only `NPM_CONFIG_REGISTRY` from the host environment.
 * `NPM_AUTH_TOKEN` is intentionally not forwarded, even though a caller might expect it to be.
 */
const dockerNpmEnvNames = ["NPM_CONFIG_REGISTRY"] as const;

function toBundledFileUrl(path: Path.Path, hostPath: string) {
  const url = new URL("file:///");
  url.pathname = toDockerPath(hostPath, path).replaceAll("%", "%25");
  return url.toString();
}

export interface DockerBind {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly mode: "ro" | "rw";
  readonly externalScope: boolean;
}

export function formatDockerBind(bind: DockerBind) {
  return `${bind.hostPath}:${bind.containerPath}:${bind.mode}`;
}

/**
 * Drops every bind another bind already supplies verbatim: same mode, host
 * path strictly beneath the other's, container path at the same relative
 * offset. The import walker and import-map target enumeration routinely emit
 * such pairs, and Docker rejects `docker cp` into a created container whose config nests a file
 * bind inside a read-only parent bind. A bind that overrides its parent's source, mode, or
 * container mapping is never collapsed.
 */
export function pruneRedundantDockerBinds(
  binds: ReadonlyArray<DockerBind>,
): ReadonlyArray<DockerBind> {
  const entries = binds.map((bind) => ({ bind, host: toSlash(bind.hostPath) }));
  const isCovered = (child: { readonly bind: DockerBind; readonly host: string }) =>
    entries.some((parent) => {
      if (parent.bind.mode !== child.bind.mode) {
        return false;
      }
      // Only a root path keeps its trailing separator through resolve/realpath,
      // so each prefix appends one exactly when its own side lacks it; the
      // host-equality guard is what then keeps a root bind from covering
      // itself.
      const hostPrefix = parent.host.endsWith("/") ? parent.host : `${parent.host}/`;
      const containerPrefix = parent.bind.containerPath.endsWith("/")
        ? parent.bind.containerPath
        : `${parent.bind.containerPath}/`;
      return (
        child.host !== parent.host &&
        child.host.startsWith(hostPrefix) &&
        child.bind.containerPath === `${containerPrefix}${child.host.slice(hostPrefix.length)}`
      );
    });
  return entries.filter((entry) => !isCovered(entry)).map((entry) => entry.bind);
}

function dockerNpmEnv(env: NodeJS.ProcessEnv = process.env): ReadonlyArray<string> {
  return dockerNpmEnvNames.flatMap((name) => {
    const value = env[name];
    return value === undefined || value === "" ? [] : [name];
  });
}

function toApiRelativePath(path: Path.Path, cwd: string, hostPath: string) {
  const resolved = path.resolve(hostPath);
  const relativePath = path.relative(cwd, resolved);
  return toSlash(relativePath.length > 0 ? relativePath : path.basename(resolved));
}

function isContainedPath(path: Path.Path, root: string, candidate: string) {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relativePath === "" ||
    (!path.isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`))
  );
}

function isContainedInAnyPath(path: Path.Path, roots: ReadonlyArray<string>, candidate: string) {
  return roots.some((root) => isContainedPath(path, root, candidate));
}

const hostError = (pathname: string) => (error: PlatformError.PlatformError) =>
  nativePlatformFailure(error, pathname).cause;

const unknownHostError = (pathname: string) => (error: PlatformError.PlatformError) =>
  new Cause.UnknownError(hostError(pathname)(error), "An error occurred in Effect.tryPromise");

const debugEnvEnabled = Config.option(Config.string("DEBUG")).pipe(
  Effect.map(Option.exists((value) => value === "true")),
  Effect.orDie,
);

function hasErrorCode(error: Error, code: string) {
  return "code" in error && error.code === code;
}

const hostRealPath = Effect.fnUntraced(function* (pathname: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(pathname).pipe(Effect.mapError(hostError(pathname)));
});

const hostReadFile = Effect.fnUntraced(function* (pathname: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFile(pathname).pipe(Effect.mapError(hostError(pathname)));
});

const hostStat = Effect.fnUntraced(function* (pathname: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(pathname).pipe(Effect.mapError(hostError(pathname)));
});

/**
 * Rejects any path containing a `..` segment before it's uploaded. A workdir that differs from
 * the git root can otherwise produce a multipart `File` name like
 * `../packages/shared/src/index.ts` that escapes the anchor directory.
 */
function hasParentPathSegment(relativePath: string) {
  return toSlash(relativePath)
    .split("/")
    .some((segment) => segment === "..");
}

const realpathIfExists = Effect.fnUntraced(function* (pathname: string) {
  const path = yield* Path.Path;
  return yield* hostRealPath(path.resolve(pathname)).pipe(
    Effect.catchIf(
      // ENOTDIR (a path routed through a file) is as nonexistent as ENOENT here.
      (error) => hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR"),
      () => Effect.succeed(path.resolve(pathname)),
    ),
  );
});

const resolveFunctionsSourceRoot = Effect.fnUntraced(function* (projectRoot: string) {
  const path = yield* Path.Path;
  return Option.getOrElse(yield* findGitRootPath(projectRoot), () => path.resolve(projectRoot));
});

function humanSize(bytes: number) {
  if (bytes < 1000) {
    return `${bytes} B`;
  }
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes;
  let index = -1;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  const precision = value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[index]}`;
}

function stripJsonComments(contents: string): string {
  const src = contents.replace(/^\uFEFF/, "");
  const out: Array<string> = [];
  let pendingCommaIndex = -1;
  let index = 0;
  while (index < src.length) {
    const char = src.charAt(index);

    if (char === '"') {
      pendingCommaIndex = -1;
      out.push(char);
      index += 1;
      while (index < src.length) {
        const stringChar = src.charAt(index);
        out.push(stringChar);
        index += 1;
        if (stringChar === "\\") {
          if (index < src.length) {
            out.push(src.charAt(index));
            index += 1;
          }
        } else if (stringChar === '"') {
          break;
        }
      }
      continue;
    }

    if (char === "/" && src.charAt(index + 1) === "/") {
      index += 2;
      while (index < src.length && src.charAt(index) !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && src.charAt(index + 1) === "*") {
      index += 2;
      while (index < src.length && !(src.charAt(index) === "*" && src.charAt(index + 1) === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }

    if (char === ",") {
      pendingCommaIndex = out.length;
      out.push(char);
      index += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      if (pendingCommaIndex >= 0) {
        out[pendingCommaIndex] = "";
        pendingCommaIndex = -1;
      }
      out.push(char);
      index += 1;
      continue;
    }

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      out.push(char);
      index += 1;
      continue;
    }

    pendingCommaIndex = -1;
    out.push(char);
    index += 1;
  }
  return out.join("");
}

function resolveImportTarget(path: Path.Path, jsonPath: string, target: string) {
  if (target.startsWith("/")) {
    return target;
  }

  try {
    const parsed = new URL(target);
    if (parsed.protocol.length > 0) {
      return target;
    }
  } catch {
    // Fall through.
  }

  const resolved = toSlash(path.join(path.dirname(jsonPath), target));
  const normalized =
    resolved.startsWith("/") ||
    WINDOWS_ABSOLUTE_PATH.test(resolved) ||
    resolved.startsWith("./") ||
    resolved.startsWith("../")
      ? resolved
      : `./${resolved}`;
  return target.endsWith("/") && !normalized.endsWith("/") ? `${normalized}/` : normalized;
}

function isRemoteImportTarget(target: string) {
  if (target.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(target)) {
    return false;
  }
  try {
    const parsed = new URL(target);
    return parsed.protocol.length > 0;
  } catch {
    return false;
  }
}

function getObjectProperty(input: object, key: string): unknown {
  return Reflect.get(input, key);
}

const readStringMap = Effect.fnUntraced(function* (input: unknown, fieldName: string) {
  if (input === undefined) {
    return {};
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return yield* new FunctionDeployError({
      message: `failed to parse import map: expected ${fieldName} to be an object`,
    });
  }

  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") {
      return yield* new FunctionDeployError({
        message: `failed to parse import map: expected ${fieldName}.${key} to be a string`,
      });
    }
    values[key] = value;
  }
  return values;
});

class ImportMapFile {
  readonly imports: Record<string, string>;
  readonly scopes: Record<string, Record<string, string>>;
  readonly importMapReference: string;

  constructor(
    imports: Record<string, string> = {},
    scopes: Record<string, Record<string, string>> = {},
    importMapReference = "",
  ) {
    this.imports = imports;
    this.scopes = scopes;
    this.importMapReference = importMapReference;
  }

  static readonly fromUnknown = Effect.fnUntraced(function* (input: unknown) {
    const imports: Record<string, string> = {};
    const scopes: Record<string, Record<string, string>> = {};
    let importMapReference = "";

    if (typeof input === "object" && input !== null) {
      const importMap = getObjectProperty(input, "importMap");
      if (typeof importMap === "string") {
        importMapReference = importMap;
      }

      Object.assign(imports, yield* readStringMap(getObjectProperty(input, "imports"), "imports"));

      const rawScopes = getObjectProperty(input, "scopes");
      if (rawScopes === undefined) {
        return new ImportMapFile(imports, scopes, importMapReference);
      }
      if (typeof rawScopes !== "object" || rawScopes === null || Array.isArray(rawScopes)) {
        return yield* new FunctionDeployError({
          message: "failed to parse import map: expected scopes to be an object",
        });
      }
      for (const [scopeName, scopeValue] of Object.entries(rawScopes)) {
        scopes[scopeName] = yield* readStringMap(scopeValue, `scopes.${scopeName}`);
      }
    }

    return new ImportMapFile(imports, scopes, importMapReference);
  });

  isReference() {
    return (
      Object.keys(this.imports).length === 0 &&
      Object.keys(this.scopes).length === 0 &&
      this.importMapReference.length > 0
    );
  }

  resolve(path: Path.Path, jsonPath: string) {
    const imports = Object.fromEntries(
      Object.entries(this.imports).map(([key, value]) => [
        key,
        resolveImportTarget(path, jsonPath, value),
      ]),
    );
    const scopes = Object.fromEntries(
      Object.entries(this.scopes).map(([scopeName, scopeValue]) => [
        resolveImportTarget(path, jsonPath, scopeName),
        Object.fromEntries(
          Object.entries(scopeValue).map(([key, value]) => [
            key,
            resolveImportTarget(path, jsonPath, value),
          ]),
        ),
      ]),
    );
    return new ImportMapFile(imports, scopes, this.importMapReference);
  }
}

const parseImportMapContents = (contents: Uint8Array) =>
  decodeJson(stripJsonComments(new TextDecoder().decode(contents))).pipe(
    Effect.mapError((error) => new FunctionImportMapSyntaxError({ message: error.message })),
  );

const loadImportMapFile = Effect.fnUntraced(function* <E = never, R = never>(
  pathname: string,
  onRead?: (pathname: string, contents: Uint8Array) => Effect.Effect<void, E, R>,
) {
  const path = yield* Path.Path;
  const seen = new Set<string>();
  let current = pathname;
  for (;;) {
    const resolvedPath = path.resolve(current);
    if (seen.has(resolvedPath)) {
      return yield* new FunctionDeployError({ message: `cyclic import map reference: ${current}` });
    }
    seen.add(resolvedPath);
    const contents = yield* hostReadFile(current);
    if (onRead !== undefined) {
      yield* onRead(current, contents);
    }
    const parsed = yield* parseImportMapContents(contents);
    const importMap = (yield* ImportMapFile.fromUnknown(parsed)).resolve(path, toSlash(current));
    if (!(isDenoConfigFile(path, current) && importMap.isReference())) {
      return importMap;
    }
    current = path.join(path.dirname(current), importMap.importMapReference);
  }
});

function substituteImportMapValue(
  mappings: Readonly<Record<string, string>>,
  specifier: string,
): string | undefined {
  let match: [string, string] | undefined;
  for (const entry of Object.entries(mappings)) {
    const [prefix, value] = entry;
    if (prefix.length === 0) {
      continue;
    }
    // Import-maps spec (implemented by Deno): a key matches exactly, or as a prefix only when it
    // ends with "/", unlike a naive prefix match.
    if (prefix.endsWith("/")) {
      // Spec normalization: a `/`-suffixed key whose address lacks a trailing
      // `/` is an invalid mapping — dropped, not concatenated.
      if (!value.endsWith("/") || !specifier.startsWith(prefix)) {
        continue;
      }
    } else if (specifier !== prefix) {
      continue;
    }
    if (match === undefined || prefix.length > match[0].length) {
      match = entry;
    }
  }
  if (match === undefined) {
    return undefined;
  }
  return match[1] + specifier.slice(match[0].length);
}

function resolveImportSpecifier(
  importMap: ImportMapFile,
  currentPath: string,
  specifier: string,
): { readonly path: string; readonly substituted: boolean } {
  let resolved = specifier;
  let substituted = false;

  let scopedMappings: Readonly<Record<string, string>> | undefined;
  let scopedPrefixLength = -1;
  for (const [scopeName, scopeValue] of Object.entries(importMap.scopes)) {
    // Same import-maps spec rule as key matching: a scope matches exactly, or
    // as a prefix only when it ends with "/".
    const scopeMatches =
      scopeName === currentPath || (scopeName.endsWith("/") && currentPath.startsWith(scopeName));
    if (!scopeMatches || scopeName.length <= scopedPrefixLength) {
      continue;
    }
    scopedMappings = scopeValue;
    scopedPrefixLength = scopeName.length;
  }

  if (scopedMappings !== undefined) {
    const scopedResolved = substituteImportMapValue(scopedMappings, resolved);
    if (scopedResolved !== undefined) {
      resolved = scopedResolved;
      substituted = true;
    }
  }

  if (!substituted) {
    const importResolved = substituteImportMapValue(importMap.imports, resolved);
    if (importResolved !== undefined) {
      resolved = importResolved;
      substituted = true;
    }
  }

  return { path: resolved, substituted };
}

const walkImportPaths = Effect.fnUntraced(function* <
  FileError,
  FileServices,
  WarningError,
  WarningServices,
>(
  importMap: ImportMapFile,
  srcPath: string,
  allowedRoots: ReadonlyArray<string>,
  displayRoot: string,
  onFile: (pathname: string, contents: Uint8Array) => Effect.Effect<void, FileError, FileServices>,
  onWarning: (message: string) => Effect.Effect<void, WarningError, WarningServices>,
) {
  const path = yield* Path.Path;
  const seen = new Set<string>();
  const queue = [toSlash(srcPath)];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);

    const contents = yield* Effect.gen(function* () {
      const resolvedCurrent = yield* hostRealPath(path.resolve(current));
      if (!isContainedInAnyPath(path, allowedRoots, resolvedCurrent)) {
        yield* onWarning(`WARN: Skipping import path outside source root: ${current}\n`);
        return Option.none<Uint8Array>();
      }
      return Option.some(yield* hostReadFile(resolvedCurrent));
    }).pipe(
      Effect.catchIf(
        (error) => error instanceof Error && hasErrorCode(error, "ENOENT"),
        () => {
          const message = `failed to read file: open ${toApiRelativePath(path, displayRoot, current)}: no such file or directory`;
          return onWarning(`WARN: ${message}\n`).pipe(Effect.as(Option.none<Uint8Array>()));
        },
      ),
      Effect.catchIf(
        // An ENOTDIR (import path routed through a file) gets a classified, user-facing message
        // instead of an unhandled raw Node error, so telemetry books it as user-fixable config.
        (error) => error instanceof Error && hasErrorCode(error, "ENOTDIR"),
        () =>
          Effect.fail(
            new FunctionImportNotDirectoryError({
              message: `failed to read file: open ${toApiRelativePath(path, displayRoot, current)}: not a directory`,
            }),
          ),
      ),
    );
    if (Option.isNone(contents)) {
      continue;
    }

    yield* onFile(current, contents.value);
    const text = new TextDecoder().decode(contents.value);
    importPathPattern.lastIndex = 0;
    for (const match of text.matchAll(importPathPattern)) {
      const raw = match[1] ?? match[2];
      if (raw === undefined) {
        continue;
      }

      const currentPath = toSlash(current);
      let { path: modulePath, substituted } = resolveImportSpecifier(
        importMap,
        currentPath,
        raw.trim(),
      );
      modulePath = toSlash(modulePath);

      // A module file needs a dot in the final path segment: a dot earlier in the path
      // (`dist/index.mjs/core`) is a directory-shaped path, not a module file. Not basename():
      // a trailing-slash directory import must yield an empty final segment here.
      const finalSegment = modulePath.slice(modulePath.lastIndexOf("/") + 1);
      if (!finalSegment.includes(".")) {
        continue;
      }
      if (
        !modulePath.startsWith("./") &&
        !modulePath.startsWith("../") &&
        !modulePath.startsWith("/") &&
        !WINDOWS_ABSOLUTE_PATH.test(modulePath)
      ) {
        continue;
      }

      if (!substituted && (modulePath.startsWith("./") || modulePath.startsWith("../"))) {
        modulePath = toSlash(path.join(path.dirname(current), modulePath));
      }

      const resolvedModule = path.resolve(modulePath);
      const containmentPath = yield* realpathIfExists(resolvedModule);
      if (!isContainedInAnyPath(path, allowedRoots, containmentPath)) {
        yield* onWarning(`WARN: Skipping import path outside source root: ${modulePath}\n`);
        continue;
      }
      queue.push(toSlash(resolvedModule));
    }
  }
});

function hasGlobMeta(pattern: string) {
  return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

function defaultFunctionEntrypoint(path: Path.Path, functionsDir: string, slug: string) {
  return path.join(functionsDir, slug, "index.ts");
}

function defaultFunctionImportMap(path: Path.Path, functionsDir: string, slug: string) {
  return path.join(functionsDir, slug, "deno.json");
}

function globToRegExp(pattern: string) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === undefined) {
      continue;
    }
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const closeIndex = pattern.indexOf("]", index + 1);
      if (closeIndex > index + 1) {
        const content = pattern.slice(index + 1, closeIndex);
        source += `[${content.startsWith("!") ? `^${content.slice(1)}` : content}]`;
        index = closeIndex;
        continue;
      }
    }
    source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  source += "$";
  return new RegExp(source);
}

function globBaseDirectory(path: Path.Path, pattern: string) {
  const normalized = toSlash(pattern);
  if (!hasGlobMeta(normalized)) {
    return path.dirname(normalized);
  }
  const parts = normalized.split("/");
  const stableParts: string[] = [];
  for (const part of parts) {
    if (part.includes("*") || part.includes("?") || part.includes("[")) {
      break;
    }
    stableParts.push(part);
  }
  if (stableParts.length === 0) {
    return ".";
  }
  return stableParts.join("/");
}

const isNonSymlinkDirectory = Effect.fnUntraced(function* (pathname: string) {
  const fs = yield* FileSystem.FileSystem;
  const isDirectory = yield* fs.stat(pathname).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );
  if (!isDirectory) {
    return false;
  }
  return !(yield* Effect.isSuccess(fs.readLink(pathname)));
});

const listPathsRecursive: (
  root: string,
) => Effect.Effect<ReadonlyArray<string>, Error, FileSystem.FileSystem | Path.Path> =
  Effect.fnUntraced(function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolvedRoot = path.resolve(root);
    const entries = yield* fs
      .readDirectory(resolvedRoot)
      .pipe(Effect.mapError(hostError(resolvedRoot)));
    const paths: string[] = [];
    for (const entry of entries) {
      const pathname = path.join(resolvedRoot, entry);
      paths.push(pathname);
      if (yield* isNonSymlinkDirectory(pathname)) {
        paths.push(...(yield* listPathsRecursive(pathname)));
      }
    }
    return paths;
  });

const expandStaticPattern = Effect.fnUntraced(function* (pattern: string) {
  const path = yield* Path.Path;
  if (!hasGlobMeta(pattern)) {
    yield* hostStat(pattern).pipe(
      Effect.mapError(
        () => new FunctionDeployError({ message: `no files matched pattern: ${pattern}` }),
      ),
    );
    return [pattern];
  }

  const baseDir = globBaseDirectory(path, pattern);
  const matcher = yield* Effect.try({
    try: () => globToRegExp(toSlash(path.resolve(pattern))),
    catch: (cause) =>
      new FunctionDeployError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });
  const candidates = yield* listPathsRecursive(baseDir).pipe(
    Effect.mapError((error) =>
      hasErrorCode(error, "ENOENT")
        ? new FunctionDeployError({ message: `no files matched pattern: ${pattern}` })
        : error,
    ),
  );
  const matches = candidates.filter((candidate) => matcher.test(toSlash(path.resolve(candidate))));
  if (matches.length === 0) {
    return yield* new FunctionDeployError({ message: `no files matched pattern: ${pattern}` });
  }
  return matches;
});

const forEachLocalImportMapTarget = Effect.fnUntraced(function* <E, R>(
  importMap: ImportMapFile,
  onTarget: (pathname: string, kind: "import" | "scope") => Effect.Effect<void, E, R>,
) {
  for (const target of Object.values(importMap.imports)) {
    if (isRemoteImportTarget(target)) {
      continue;
    }
    yield* onTarget(target, "import");
  }
  for (const scope of Object.values(importMap.scopes)) {
    for (const target of Object.values(scope)) {
      if (isRemoteImportTarget(target)) {
        continue;
      }
      yield* onTarget(target, "scope");
    }
  }
});

const walkLocalImportMapTargetImports = Effect.fnUntraced(function* <
  FileError,
  FileServices,
  WarningError,
  WarningServices,
>(
  importMap: ImportMapFile,
  pathname: string,
  allowedRoots: ReadonlyArray<string>,
  displayRoot: string,
  onFile: (pathname: string, contents: Uint8Array) => Effect.Effect<void, FileError, FileServices>,
  onWarning: (message: string) => Effect.Effect<void, WarningError, WarningServices>,
) {
  if ((yield* hostStat(pathname)).type === "Directory") {
    return;
  }
  yield* walkImportPaths(importMap, pathname, allowedRoots, displayRoot, onFile, onWarning);
});

const isFile = Effect.fnUntraced(function* (pathname: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(pathname).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.orElseSucceed(() => false),
  );
});

const resolveImportMapAllowedRoots = Effect.fnUntraced(function* (
  projectRoot: string,
  importMapPath: string,
) {
  const path = yield* Path.Path;
  const realProjectRoot = yield* hostRealPath(projectRoot);
  const allowedRoots = [realProjectRoot];
  if (importMapPath.length === 0) {
    return allowedRoots;
  }

  const realImportMapPath = yield* hostRealPath(importMapPath);
  if (!isContainedPath(path, realProjectRoot, realImportMapPath)) {
    allowedRoots.push(path.dirname(realImportMapPath));
  }
  if (isDenoConfigFile(path, importMapPath)) {
    const contents = yield* hostReadFile(importMapPath);
    const parsed = yield* parseImportMapContents(contents);
    const importMap = yield* ImportMapFile.fromUnknown(parsed);
    if (importMap.importMapReference.length > 0) {
      const referencedImportMapPath = yield* hostRealPath(
        path.join(path.dirname(importMapPath), importMap.importMapReference),
      );
      if (!isContainedPath(path, realProjectRoot, referencedImportMapPath)) {
        allowedRoots.push(path.dirname(referencedImportMapPath));
      }
    }
  }
  return allowedRoots;
});

const collectSourceDeployFiles = Effect.fnUntraced(function* (
  sourceRoot: string,
  workdir: string,
  config: ResolvedDeployFunctionConfig,
  metadata: SourceDeployMetadata,
  outputRaw: (text: string) => Effect.Effect<void, never>,
) {
  const path = yield* Path.Path;
  const files: Array<File> = [];
  const realSourceRoot = yield* hostRealPath(sourceRoot);
  const importMapAllowedRoots = yield* resolveImportMapAllowedRoots(sourceRoot, config.importMap);
  const uploadedAssets = new Set<string>();

  const appendAsset = Effect.fnUntraced(function* (
    pathname: string,
    contents: Uint8Array,
    realPathname: string,
  ) {
    if (uploadedAssets.has(realPathname)) {
      return;
    }
    uploadedAssets.add(realPathname);
    // Uploaded file names are anchored at the workdir, not at `sourceRoot` — see the note in
    // `deployViaApi`.
    const relativePath = toApiRelativePath(path, workdir, pathname);
    if (hasParentPathSegment(relativePath)) {
      return yield* new FunctionDeployError({
        message: `failed to read file: open ${relativePath}: invalid argument`,
      });
    }
    yield* outputRaw(`Uploading asset (${config.slug}): ${relativePath}\n`);
    files.push(new File([contents], relativePath));
  });

  const uploadAsset = Effect.fnUntraced(function* (pathname: string, contents: Uint8Array) {
    const realPathname = yield* hostRealPath(pathname);
    if (!isContainedPath(path, realSourceRoot, realPathname)) {
      return yield* new FunctionDeployError({
        message: `refusing to upload asset outside source root: ${pathname}`,
      });
    }
    yield* appendAsset(pathname, contents, realPathname);
  });

  const uploadImportMapAsset = Effect.fnUntraced(function* (
    pathname: string,
    contents: Uint8Array,
  ) {
    const realPathname = yield* hostRealPath(pathname);
    if (!isContainedInAnyPath(path, importMapAllowedRoots, realPathname)) {
      return yield* new FunctionDeployError({
        message: `refusing to upload import map outside allowed roots: ${pathname}`,
      });
    }
    yield* appendAsset(pathname, contents, realPathname);
  });

  const uploadImportMapTargetAsset = Effect.fnUntraced(function* (
    pathname: string,
    contents: Uint8Array,
  ) {
    const realPathname = yield* hostRealPath(pathname);
    if (!isContainedInAnyPath(path, importMapAllowedRoots, realPathname)) {
      yield* outputRaw(`WARN: Skipping import path outside source root: ${pathname}\n`);
      return;
    }
    yield* appendAsset(pathname, contents, realPathname);
  });

  const uploadScopeTarget = Effect.fnUntraced(function* (pathname: string) {
    const target = yield* hostRealPath(pathname).pipe(
      Effect.flatMap((resolvedPath) =>
        hostStat(pathname).pipe(Effect.map((pathInfo) => Option.some({ resolvedPath, pathInfo }))),
      ),
      Effect.catchIf(
        (error) => hasErrorCode(error, "ENOTDIR"),
        () =>
          outputRaw(`WARN: Skipping import map target that is not a directory: ${pathname}\n`).pipe(
            Effect.as(Option.none()),
          ),
      ),
    );
    if (Option.isNone(target)) {
      return;
    }
    const { resolvedPath, pathInfo } = target.value;
    if (!isContainedInAnyPath(path, importMapAllowedRoots, resolvedPath)) {
      yield* outputRaw(`WARN: Skipping import path outside source root: ${pathname}\n`);
      return;
    }
    if (pathInfo.type !== "Directory") {
      yield* uploadImportMapTargetAsset(pathname, yield* hostReadFile(pathname));
      yield* walkLocalImportMapTargetImports(
        importMap,
        pathname,
        importMapAllowedRoots,
        workdir,
        uploadImportMapTargetAsset,
        outputRaw,
      );
      return;
    }
    const nestedPaths = yield* listPathsRecursive(pathname);
    for (const nestedPath of nestedPaths) {
      if ((yield* hostStat(nestedPath)).type === "Directory") {
        continue;
      }
      const resolvedNestedPath = yield* hostRealPath(nestedPath);
      if (!isContainedInAnyPath(path, importMapAllowedRoots, resolvedNestedPath)) {
        yield* outputRaw(`WARN: Skipping import path outside source root: ${nestedPath}\n`);
        continue;
      }
      yield* uploadImportMapTargetAsset(nestedPath, yield* hostReadFile(nestedPath));
    }
  });

  if (metadata.import_map_path !== undefined && metadata.import_map_path.length > 0) {
    yield* loadImportMapFile(config.importMap, uploadImportMapAsset);
  }

  for (const pattern of config.staticFiles) {
    const matches = yield* expandStaticPattern(pattern).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        outputRaw(`WARN: ${error.message}\n`).pipe(Effect.as(Option.none<ReadonlyArray<string>>())),
      ),
    );
    if (Option.isNone(matches)) {
      continue;
    }
    for (const pathname of matches.value) {
      if ((yield* hostStat(pathname)).type === "Directory") {
        return yield* new FunctionDeployError({ message: `file path is a directory: ${pathname}` });
      }
      yield* uploadAsset(pathname, yield* hostReadFile(pathname));
    }
  }

  const importMap =
    metadata.import_map_path !== undefined && metadata.import_map_path.length > 0
      ? yield* loadImportMapFile(config.importMap)
      : new ImportMapFile();
  yield* walkImportPaths(
    importMap,
    config.entrypoint,
    [realSourceRoot],
    workdir,
    uploadAsset,
    outputRaw,
  );
  yield* forEachLocalImportMapTarget(importMap, uploadScopeTarget);

  return files;
});

/**
 * Server-recorded metadata paths are anchored at the workdir, with forward slashes regardless of
 * platform — see the note in `deployViaApi`.
 */
function createSourceMetadata(
  path: Path.Path,
  workdir: string,
  config: ResolvedDeployFunctionConfig,
  remote?: RemoteFunction,
): SourceDeployMetadata {
  const verifyJwt = config.verifyJwt ?? remote?.verify_jwt;
  return {
    name: config.slug,
    ...(verifyJwt === undefined ? {} : { verify_jwt: verifyJwt }),
    entrypoint_path: toApiRelativePath(path, workdir, config.entrypoint),
    import_map_path:
      config.importMap.length > 0 ? toApiRelativePath(path, workdir, config.importMap) : "",
    static_patterns: config.staticFiles.map((pathname) =>
      toApiRelativePath(path, workdir, pathname),
    ),
  };
}

function createBundledMetadata(
  path: Path.Path,
  config: ResolvedDeployFunctionConfig,
  sha256: string,
): BundledDeployMetadata {
  return {
    name: config.slug,
    ...(config.verifyJwt === undefined ? {} : { verify_jwt: config.verifyJwt }),
    entrypoint_path: toBundledFileUrl(path, config.entrypoint),
    sha256,
    ...(config.importMap.length > 0
      ? { import_map_path: toBundledFileUrl(path, config.importMap) }
      : {}),
    ...(config.staticFiles.length > 0
      ? { static_patterns: config.staticFiles.map((pathname) => toBundledFileUrl(path, pathname)) }
      : {}),
  };
}

function sanitizeDockerBinds(
  path: Path.Path,
  binds: ReadonlyArray<DockerBind>,
  functionsDir: string,
  outputDir: string,
) {
  const normalizedFunctionsDir = `${toSlash(path.resolve(functionsDir))}/`;
  const normalizedOutputDir = `${toSlash(path.resolve(outputDir))}/`;
  const seen = new Set<string>();
  const result: DockerBind[] = [];

  for (const bind of binds) {
    const normalizedHostPath = toSlash(path.resolve(bind.hostPath));
    if (
      normalizedHostPath.startsWith(normalizedFunctionsDir) ||
      normalizedHostPath.startsWith(normalizedOutputDir)
    ) {
      continue;
    }
    const key = formatDockerBind(bind);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(bind);
    }
  }

  return result;
}

type DockerBindsOptions = {
  readonly additionalModuleRoots?: ReadonlyArray<string>;
  readonly onWarning?: (message: string) => Effect.Effect<void>;
  readonly skipMissingImportMapTargets?: boolean;
  /** Resolved marker presence, including an explicitly empty project value. */
  readonly bitbucketCloneDirDefined?: boolean;
};

// Detached so an interrupt stops waiting without stopping the walk; only this join observes it.
const joinDetached = <A, E, R>(walk: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.forkDetach(walk, { startImmediately: true }), Fiber.join);

export const buildDockerBinds = Effect.fnUntraced(function* (
  projectId: string,
  functionsDir: string,
  outputDir: string,
  config: ResolvedDeployFunctionConfig,
  options: DockerBindsOptions = {},
) {
  const path = yield* Path.Path;
  const sourceRoot = yield* resolveFunctionsSourceRoot(path.resolve(functionsDir, "..", ".."));
  return yield* joinDetached(
    buildDockerBindsWithin(sourceRoot, projectId, functionsDir, outputDir, config, options),
  ).pipe(Effect.orDie);
});

const buildDockerBindsWithin = Effect.fnUntraced(function* (
  sourceRoot: string,
  projectId: string,
  functionsDir: string,
  outputDir: string,
  config: ResolvedDeployFunctionConfig,
  options: DockerBindsOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostFunctionsDir = path.resolve(functionsDir);
  const hostOutputDir = path.resolve(outputDir);
  const realSourceRoot = yield* hostRealPath(sourceRoot);
  const moduleRoots = [
    realSourceRoot,
    ...(yield* Effect.forEach(
      options.additionalModuleRoots ?? [],
      (root) => Effect.option(fs.realPath(root)),
      { concurrency: "unbounded" },
    )).flatMap(Option.toArray),
  ];
  const importMapAllowedRoots = yield* resolveImportMapAllowedRoots(sourceRoot, config.importMap);
  const binds: DockerBind[] = [
    {
      hostPath: hostFunctionsDir,
      containerPath: toDockerPath(hostFunctionsDir, path),
      mode: "ro",
      externalScope: false,
    },
  ];
  if (options.bitbucketCloneDirDefined !== true) {
    const cacheVolume = edgeRuntimeCacheVolume(projectId);
    binds.unshift({
      hostPath: cacheVolume.name,
      containerPath: cacheVolume.containerPath,
      mode: "rw",
      externalScope: false,
    });
  }

  if (!hostOutputDir.startsWith(hostFunctionsDir)) {
    binds.push({
      hostPath: hostOutputDir,
      containerPath: toDockerPath(hostOutputDir, path),
      mode: "rw",
      externalScope: false,
    });
  }

  const warn = options.onWarning ?? (() => Effect.void);
  const extraBinds: DockerBind[] = [];
  const explicitScopeBinds = new Map<string, DockerBind>();
  const appendBindWithinRoots = Effect.fnUntraced(function* (
    roots: ReadonlyArray<string>,
    pathname: string,
  ) {
    const hostPath = yield* hostRealPath(pathname);
    const contained = isContainedInAnyPath(path, roots, hostPath);
    if (contained) {
      extraBinds.push({
        hostPath,
        containerPath: toDockerPath(hostPath, path),
        mode: "ro",
        externalScope: false,
      });
    }
    return { hostPath, contained };
  });
  const appendProjectBind = (pathname: string, _contents: Uint8Array) =>
    Effect.asVoid(appendBindWithinRoots([realSourceRoot], pathname));
  const appendModuleBind = (pathname: string, _contents: Uint8Array) =>
    Effect.asVoid(appendBindWithinRoots(moduleRoots, pathname));
  const appendImportMapBind = (pathname: string, _contents: Uint8Array) =>
    Effect.asVoid(appendBindWithinRoots(importMapAllowedRoots, pathname));
  const importMap =
    config.importMap.length > 0
      ? yield* loadImportMapFile(config.importMap, appendImportMapBind)
      : new ImportMapFile();
  yield* walkImportPaths(
    importMap,
    config.entrypoint,
    moduleRoots,
    sourceRoot,
    appendModuleBind,
    warn,
  );
  yield* forEachLocalImportMapTarget(importMap, (target, kind) =>
    Effect.gen(function* () {
      const { hostPath, contained } = yield* appendBindWithinRoots(importMapAllowedRoots, target);
      const isDirectory = (yield* hostStat(target)).type === "Directory";
      if (!contained && kind === "scope") {
        const scopeBind: DockerBind = {
          hostPath,
          containerPath: toDockerPath(target, path),
          mode: "ro",
          externalScope: true,
        };
        explicitScopeBinds.set(formatDockerBind(scopeBind), scopeBind);
      }
      if (isDirectory) {
        return;
      }
      yield* walkLocalImportMapTargetImports(
        importMap,
        target,
        importMapAllowedRoots,
        sourceRoot,
        appendImportMapBind,
        () => Effect.void,
      );
    }).pipe(
      // ENOTDIR (a trailing-slash value routed through a file) is never a
      // walkable target regardless of caller: an import that actually
      // reaches through that file still fails via the walker's
      // FunctionImportNotDirectoryError.
      Effect.catchIf(
        (error) => hasErrorCode(error, "ENOTDIR"),
        () => warn(`WARN: Skipping import map target that is not a directory: ${target}\n`),
      ),
      Effect.catchIf(
        (error) => options.skipMissingImportMapTargets === true && hasErrorCode(error, "ENOENT"),
        () => warn(`WARN: Skipping missing import map target: ${target}\n`),
      ),
    ),
  );
  for (const pattern of config.staticFiles) {
    const matches = yield* Effect.option(expandStaticPattern(pattern));
    if (Option.isNone(matches)) {
      continue;
    }
    for (const pathname of matches.value) {
      if ((yield* hostStat(pathname)).type === "Directory") {
        return yield* new FunctionDeployError({ message: `file path is a directory: ${pathname}` });
      }
      yield* appendProjectBind(pathname, new Uint8Array());
    }
  }

  const sanitizedExtraBinds = sanitizeDockerBinds(
    path,
    extraBinds,
    hostFunctionsDir,
    hostOutputDir,
  );
  const occupiedContainerPaths = new Set(
    [...binds, ...sanitizedExtraBinds].map((bind) => bind.containerPath),
  );
  const uniqueScopeBinds: DockerBind[] = [];
  for (const bind of explicitScopeBinds.values()) {
    if (occupiedContainerPaths.has(bind.containerPath)) {
      continue;
    }
    occupiedContainerPaths.add(bind.containerPath);
    uniqueScopeBinds.push(bind);
    yield* warn(
      `WARN: Mounting import map scope target outside the project root: ${bind.hostPath}\n`,
    );
  }

  return [...binds, ...sanitizedExtraBinds, ...uniqueScopeBinds];
});

function shouldUseDenoJsonDiscovery(path: Path.Path, entrypoint: string, importMap: string) {
  return isDenoConfigFile(path, importMap) && path.dirname(importMap) === path.dirname(entrypoint);
}

const shouldUsePackageJsonDiscovery = Effect.fnUntraced(function* (
  entrypoint: string,
  importMap: string,
) {
  if (importMap.length > 0) {
    return false;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.stat(path.join(path.dirname(entrypoint), "package.json")).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

interface BundleFunctionWithDockerOptions {
  readonly projectId: string;
  readonly edgeRuntimeVersion: string;
  readonly functionsDir: string;
  readonly config: ResolvedDeployFunctionConfig;
  /** Already resolved (explicit flag > `SUPABASE_NETWORK_ID` > generated) — see the caller. */
  readonly networkMode: string;
  readonly verbose?: boolean;
  readonly styleEmphasis?: (text: string) => string;
  readonly projectEnvValues?: Readonly<Record<string, string>>;
}

const bundleFunctionWithDocker = Effect.fn("functions.deploy.bundleWithDocker")(function* (
  options: BundleFunctionWithDockerOptions,
) {
  const {
    projectId,
    edgeRuntimeVersion,
    functionsDir,
    config,
    networkMode,
    verbose = false,
    styleEmphasis = (text: string) => text,
    projectEnvValues,
  } = options;
  const bitbucketCloneDirDefined = Option.isSome(yield* bitbucketCloneDir(projectEnvValues));
  const output = yield* Output;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* output.raw(`Bundling Function: ${styleEmphasis(config.slug)}\n`, "stderr");

  const outputRoot = path.resolve(functionsDir, "..", ".temp");
  yield* fs
    .makeDirectory(outputRoot, { recursive: true })
    .pipe(Effect.mapError(unknownHostError(outputRoot)));
  const outputPrefix = `.supabase-output-${config.slug}-`;
  const outputDir = yield* fs
    .makeTempDirectory({ directory: outputRoot, prefix: outputPrefix })
    .pipe(Effect.mapError(unknownHostError(path.join(outputRoot, outputPrefix))));
  try {
    // Windows ignores the 0777 mode on mkdir; calling chmod separately
    // would add an NTFS WRITE_ATTRIBUTES requirement.
    if (shouldChmodBundleOutputDirectory(process.platform)) {
      yield* fs.chmod(outputDir, 0o777).pipe(Effect.mapError(hostError(outputDir)));
    }
    const outputPath = path.join(outputDir, "output.eszip");
    // `edgeRuntimeImage` applies the tag verbatim — a `.temp/edge-runtime-version` pin flows
    // through unmodified, `v` prefix or not (see the helper's doc in `functions.shared.ts`).
    const rawImage = edgeRuntimeImage(edgeRuntimeVersion, yield* slimImagesEnabled);
    const binds = yield* buildDockerBinds(projectId, functionsDir, outputDir, config, {
      bitbucketCloneDirDefined,
      onWarning: (message) => output.raw(message, "stderr"),
    });
    // Resolved per function rather than hoisted out of the loop (unlike `download.ts`'s
    // `PulledEdgeRuntimeImage`): the first resolve failure aborts the loop, and the only added
    // cost is one cached `docker image inspect` per function.
    const image = yield* resolveFunctionsDockerImage(rawImage, projectEnvValues);
    yield* ensureDockerNetwork(networkMode, projectId);
    yield* ensureDockerNamedVolume(
      edgeRuntimeCacheVolume(projectId).name,
      projectId,
      projectEnvValues,
    );

    const env: Array<string> = [];
    if (!(yield* shouldUsePackageJsonDiscovery(config.entrypoint, config.importMap))) {
      env.push("DENO_NO_PACKAGE_JSON=1");
    }
    env.push(...dockerNpmEnv());

    const containerArgs = [
      "bundle",
      "--entrypoint",
      toDockerPath(config.entrypoint, path),
      "--output",
      toDockerPath(outputPath, path),
    ];
    if (
      config.importMap.length > 0 &&
      !shouldUseDenoJsonDiscovery(path, config.entrypoint, config.importMap)
    ) {
      containerArgs.push("--import-map", toDockerPath(config.importMap, path));
    }
    for (const staticFile of config.staticFiles) {
      containerArgs.push("--static", toDockerPath(staticFile, path));
    }
    if (verbose || (yield* debugEnvEnabled)) {
      containerArgs.push("--verbose");
    }

    const command = buildFunctionsDockerRunArgs({
      image,
      projectId,
      networkMode,
      binds: binds.map(formatDockerBind),
      env,
      // `functionsDir` is `<workdir>/supabase/functions`, same derivation as `deployViaApi`'s
      // own `projectRoot`.
      workingDir: toDockerPath(path.resolve(functionsDir, "..", ".."), path),
      containerArgs,
    });

    // Live-tees each chunk to `output.raw` as it arrives, rather than buffering the whole run
    // until exit.
    const result = yield* runChildProcess("docker", command, {
      stdout: "pipe",
      stderr: "pipe",
      onStdout: (chunk) => output.raw(chunk, output.format === "text" ? "stdout" : "stderr"),
      onStderr: (chunk) => output.raw(chunk, "stderr"),
    });
    if (result.exitCode !== 0) {
      return yield* new FunctionDeployError({
        message: `failed to bundle function: exit ${result.exitCode}`,
      });
    }

    const eszip = yield* fs.readFile(outputPath).pipe(
      Effect.mapError(
        (error) =>
          new FunctionDeployError({
            message: `failed to open eszip: ${hostError(outputPath)(error).message}`,
          }),
      ),
    );
    const compressed = new Uint8Array(
      Buffer.concat([
        Buffer.from(COMPRESSED_ESZIP_MAGIC),
        brotliCompressSync(eszip, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 6,
          },
        }),
      ]),
    );
    const sha256 = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", compressed));
    const hash = Buffer.from(sha256).toString("hex");
    yield* Effect.annotateCurrentSpan({ "bundle.bytes": compressed.byteLength });
    return {
      slug: config.slug,
      metadata: createBundledMetadata(path, config, hash),
      body: compressed,
    } satisfies BundledFunction;
  } finally {
    yield* fs.remove(outputDir, { recursive: true, force: true }).pipe(Effect.ignore);
  }
});

const listRemoteFunctions = Effect.fn("functions.deploy.listRemoteFunctions")(function* (
  api: ApiClient,
  projectRef: string,
) {
  let lastError: Error | FunctionsApiStatusError | undefined;
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    const result = yield* api
      .executeRaw(operationDefinitions.v1ListAllFunctions, { ref: projectRef })
      .pipe(
        Effect.map((response) => ({ success: true as const, response })),
        Effect.catch((error) =>
          Effect.succeed({
            success: false as const,
            error: mapTransportError("failed to list functions", error),
          }),
        ),
      );

    if (result.success) {
      const body = yield* result.response.text.pipe(Effect.orElseSucceed(() => ""));
      if (result.response.status === 200) {
        // A 200 whose body is not the expected JSON is an API-response problem,
        // not a transport failure — surface it via FunctionsApiStatusError so it
        // classifies as api_status rather than network.
        return yield* decodeFunctionListResponse(body).pipe(
          Effect.mapError(
            (error) =>
              new FunctionsApiStatusError({
                status: result.response.status,
                message: `failed to read functions list: ${error.message}`,
                decode: true,
              }),
          ),
        );
      }
      lastError = new FunctionsApiStatusError({
        status: result.response.status,
        message: `unexpected list functions status ${result.response.status}: ${body}`,
      });
      if (result.response.status < 500 && result.response.status !== 429) {
        return yield* Effect.fail(lastError);
      }
    } else {
      lastError = result.error;
    }

    if (attempt < 3) {
      yield* Effect.sleep(Duration.millis(1_000 * 2 ** attempt));
    }
  }
  return yield* Effect.fail(
    lastError ?? new FunctionDeployError({ message: "failed to list functions" }),
  );
});

function headerValue(headers: Readonly<Record<string, string | undefined>>, name: string) {
  return headers[name.toLowerCase()] ?? headers[name];
}

function parseRateLimitDelay(value: string | undefined, now: number): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) {
    return Math.max(seconds, 0) * 1_000;
  }
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.max(timestamp - now, 0);
  }
  return undefined;
}

function rateLimitDelayMillis(
  headers: Readonly<Record<string, string | undefined>>,
  attempt: number,
  now: number,
) {
  return (
    parseRateLimitDelay(headerValue(headers, "retry-after"), now) ??
    parseRateLimitDelay(headerValue(headers, "x-ratelimit-reset"), now) ??
    1_000 * 2 ** Math.min(attempt, 5)
  );
}

function rateLimitDelayText(milliseconds: number) {
  return `${Math.round(milliseconds / 1_000)}s`;
}

const rateLimitedRequest = Effect.fnUntraced(function* <A>(
  action: string,
  request: () => Effect.Effect<
    {
      readonly status: number;
      readonly headers: Readonly<Record<string, string | undefined>>;
      readonly body: Effect.Effect<A, Error>;
    },
    Error
  >,
) {
  const output = yield* Output;
  for (let attempt = 0; ; attempt += 1) {
    const response = yield* request();
    if (response.status !== 429 || attempt >= DEPLOY_RATE_LIMIT_MAX_RETRIES) {
      return response;
    }
    const delayMs = rateLimitDelayMillis(response.headers, attempt, yield* Clock.currentTimeMillis);
    yield* output.raw(
      `Rate limit exceeded while ${action}. Retrying in ${rateLimitDelayText(delayMs)}.\n`,
      "stderr",
    );
    yield* Effect.sleep(Duration.millis(delayMs));
  }
});

const uploadFunctionSource = Effect.fn("functions.deploy.uploadFunctionSource")(function* (
  api: ApiClient,
  projectRef: string,
  sourceRoot: string,
  workdir: string,
  config: ResolvedDeployFunctionConfig,
  metadata: SourceDeployMetadata,
  bundleOnly: boolean,
) {
  const output = yield* Output;
  const files = yield* joinDetached(
    collectSourceDeployFiles(sourceRoot, workdir, config, metadata, (text) =>
      output.raw(text, "stderr"),
    ),
  ).pipe(
    Effect.catchDefect((defect) =>
      Effect.fail(
        defect instanceof Error ? defect : new FunctionDeployError({ message: String(defect) }),
      ),
    ),
  );
  const response = yield* rateLimitedRequest(`deploying function ${config.slug}`, () =>
    api
      .executeRaw(operationDefinitions.v1DeployAFunction, {
        ref: projectRef,
        slug: config.slug,
        ...(bundleOnly ? { bundleOnly: true } : {}),
        body: {
          metadata,
          file: files,
        },
      })
      .pipe(
        // Read the body as text (never failing) so the status check below wins:
        // a non-201 with a non-JSON body, or a 201 with malformed JSON, must
        // classify as a status/response problem — not fall through
        // `mapTransportError` as a network failure.
        Effect.map((raw) => ({
          status: raw.status,
          headers: raw.headers,
          body: raw.text.pipe(Effect.orElseSucceed(() => "")),
        })),
        Effect.mapError((error) => mapTransportError("failed to deploy function", error)),
      ),
  );
  const body = yield* response.body;
  if (response.status !== 201) {
    return yield* new FunctionsApiStatusError({
      status: response.status,
      message: `unexpected deploy status ${response.status}: ${formatUnexpectedStatusBody(body)}`,
    });
  }
  // A 201 whose body is not the expected JSON is an API-response problem, not a
  // transport failure — surface it via FunctionsApiStatusError so it classifies
  // as api_status rather than network.
  return yield* decodeDeployFunctionResponse(body).pipe(
    Effect.mapError(
      (error) =>
        new FunctionsApiStatusError({
          status: response.status,
          message: `failed to read deploy response: ${error.message}`,
          decode: true,
        }),
    ),
  );
});

function toBulkUpdateItem(remote: RemoteFunction | DeployFunctionResponse): BulkUpdateFunction {
  return {
    id: remote.id,
    slug: remote.slug,
    name: remote.name,
    status: remote.status,
    version: remote.version,
    ...(remote.created_at === undefined ? {} : { created_at: remote.created_at }),
    ...(remote.verify_jwt == null ? {} : { verify_jwt: remote.verify_jwt }),
    ...(remote.import_map == null ? {} : { import_map: remote.import_map }),
    ...(remote.entrypoint_path == null ? {} : { entrypoint_path: remote.entrypoint_path }),
    ...(remote.import_map_path == null ? {} : { import_map_path: remote.import_map_path }),
    ...(remote.ezbr_sha256 == null ? {} : { ezbr_sha256: remote.ezbr_sha256 }),
  };
}

const bulkUpdateRemoteFunctions = Effect.fn("functions.deploy.bulkUpdateFunctions")(function* (
  api: ApiClient,
  projectRef: string,
  functions: ReadonlyArray<BulkUpdateFunction>,
) {
  let lastError: Error | FunctionsApiStatusError | undefined;
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    const result = yield* rateLimitedRequest("bulk updating functions", () =>
      api
        .executeRaw(operationDefinitions.v1BulkUpdateFunctions, {
          ref: projectRef,
          body: functions.map(toBulkUpdateItem),
        })
        .pipe(
          // Read the body as text (never failing) so the status check wins even
          // if the body cannot be read.
          Effect.map((raw) => ({
            status: raw.status,
            headers: raw.headers,
            body: raw.text.pipe(Effect.orElseSucceed(() => "")),
          })),
          Effect.mapError((error) => mapTransportError("failed to bulk update", error)),
        ),
    ).pipe(
      Effect.map((response) => ({ success: true as const, response })),
      Effect.catch((error) =>
        Effect.succeed({
          success: false as const,
          error,
        }),
      ),
    );

    if (result.success) {
      const body = yield* result.response.body;
      if (result.response.status === 200) {
        return;
      }
      lastError = new FunctionsApiStatusError({
        status: result.response.status,
        message: `unexpected bulk update status ${result.response.status}: ${body}`,
      });
      if (result.response.status < 500) {
        return yield* Effect.fail(lastError);
      }
    } else {
      lastError = result.error;
    }

    if (attempt < 3) {
      yield* Effect.sleep(Duration.millis(1_000 * 2 ** attempt));
    }
  }
  return yield* Effect.fail(
    lastError ?? new FunctionDeployError({ message: "failed to bulk update" }),
  );
});

const upsertBundledFunction = Effect.fn("functions.deploy.upsertFunction")(function* (
  api: ApiClient,
  projectRef: string,
  bundled: BundledFunction,
  exists: boolean,
) {
  let shouldUpdate = exists;
  let lastError: Error | FunctionsApiStatusError | undefined;

  for (let attempt = 0; attempt <= 3; attempt += 1) {
    const action = shouldUpdate ? "update" : "create";
    const updateInput = {
      ref: projectRef,
      ...(bundled.metadata.verify_jwt === undefined
        ? {}
        : { verify_jwt: bundled.metadata.verify_jwt }),
      entrypoint_path: bundled.metadata.entrypoint_path,
      ...(bundled.metadata.import_map_path === undefined
        ? {}
        : { import_map_path: bundled.metadata.import_map_path }),
      ezbr_sha256: bundled.metadata.sha256,
      body: bundled.body,
    };
    const createInput = {
      ...updateInput,
      slug: bundled.slug,
      name: bundled.slug,
    };
    const request = shouldUpdate
      ? api.executeRaw(operationDefinitions.v1UpdateAFunction, {
          ...updateInput,
          function_slug: bundled.slug,
        })
      : api.executeRaw(operationDefinitions.v1CreateAFunction, createInput);
    const response = yield* request.pipe(
      Effect.map((value) => ({ success: true as const, value })),
      Effect.catch((error) =>
        Effect.succeed({
          success: false as const,
          error: mapTransportError(`failed to ${action} function`, error),
        }),
      ),
    );

    if (response.success) {
      const expectedStatus = shouldUpdate ? 200 : 201;
      if (response.value.status === expectedStatus) {
        // A success status with a malformed / unexpected JSON body is an
        // API-response problem, not a transport failure — surface it via
        // FunctionsApiStatusError so it classifies as api_status not network.
        const body = yield* response.value.text.pipe(Effect.orElseSucceed(() => ""));
        return yield* decodeDeployFunctionResponse(body).pipe(
          Effect.mapError(
            (error) =>
              new FunctionsApiStatusError({
                status: response.value.status,
                message: `failed to read function response: ${error.message}`,
                decode: true,
              }),
          ),
        );
      }

      const body = yield* response.value.text.pipe(Effect.orElseSucceed(() => ""));
      if (!shouldUpdate && body.includes("Duplicated function slug")) {
        shouldUpdate = true;
      }
      lastError = new FunctionsApiStatusError({
        status: response.value.status,
        message: `unexpected ${action} function status ${response.value.status}: ${body}`,
        notFoundIsInvalidInput: shouldUpdate,
      });
    } else {
      lastError = response.error;
    }

    if (attempt < 3) {
      yield* Effect.sleep(Duration.millis(500 * 2 ** attempt));
    }
  }

  return yield* Effect.fail(
    lastError ?? new FunctionDeployError({ message: "failed to upsert function" }),
  );
});

const deleteRemoteFunction = Effect.fn("functions.deploy.deleteFunction")(function* (
  api: ApiClient,
  projectRef: string,
  slug: string,
) {
  const response = yield* api
    .executeRaw(operationDefinitions.v1DeleteAFunction, {
      ref: projectRef,
      function_slug: slug,
    })
    .pipe(Effect.mapError((error) => mapTransportError("failed to delete function", error)));

  if (response.status === 200 || response.status === 404) {
    return;
  }
  const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
  return yield* new FunctionsApiStatusError({
    status: response.status,
    message: `unexpected delete function status ${response.status}: ${body}`,
  });
});

export const discoverFunctionSlugs = Effect.fn("functions.deploy.discoverSlugs")(function* (
  projectRoot: string,
  configDeclaredFunctions: Readonly<Record<string, ManifestFunctionConfig>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const functionsDir = path.join(projectRoot, SUPABASE_FUNCTIONS_DIR);
  const slugs: string[] = [];

  const entries = yield* fs.readDirectory(functionsDir).pipe(
    Effect.mapError(hostError(functionsDir)),
    Effect.catchIf(
      (error) => hasErrorCode(error, "ENOENT"),
      () => Effect.undefined,
    ),
  );
  if (entries !== undefined) {
    for (const slug of entries.sort((left, right) => left.localeCompare(right))) {
      const isDirectory = yield* fs.stat(path.join(functionsDir, slug)).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
      if (!isDirectory) {
        continue;
      }
      if (validateFunctionSlugMessage(slug) !== undefined) {
        continue;
      }
      const hasDefaultEntrypoint = yield* isFile(
        defaultFunctionEntrypoint(path, functionsDir, slug),
      );
      if (hasDefaultEntrypoint) {
        slugs.push(slug);
      }
    }
  }

  const configSlugs = yield* validateConfigFunctionSlugs(configDeclaredFunctions);
  return [...new Set([...slugs, ...configSlugs])];
});

const validateConfigFunctionSlugs = Effect.fnUntraced(function* (
  configFunctions: Readonly<Record<string, ManifestFunctionConfig>>,
) {
  const configSlugs = Object.keys(configFunctions).sort((left, right) => left.localeCompare(right));
  for (const slug of configSlugs) {
    yield* validateDeploySlug(slug);
  }
  return configSlugs;
});

export const resolveFunctionConfigs = Effect.fn("functions.deploy.resolveConfigs")(
  function* (input: {
    readonly slugs: ReadonlyArray<string>;
    readonly cwd: string;
    readonly projectRoot: string;
    readonly supabaseDir: string;
    readonly configFunctions: Readonly<Record<string, ManifestFunctionConfig>>;
    readonly configDeclaredFunctions: Readonly<Record<string, ManifestFunctionConfig>>;
    readonly rawConfigFunctions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly importMapOverride: Option.Option<string>;
    readonly noVerifyJwtOverride: Option.Option<boolean>;
  }) {
    const output = yield* Output;
    const path = yield* Path.Path;
    const functionsDir = path.join(input.projectRoot, SUPABASE_FUNCTIONS_DIR);
    const seenDeprecatedImportMap = new Set<string>();
    const seenFallbackImportMap = new Set<string>();
    const resolved: ResolvedDeployFunctionConfig[] = [];

    const fallbackImportMapPath = path.join(functionsDir, "import_map.json");
    const fallbackExists = yield* isFile(fallbackImportMapPath);

    const importMapOverride = Option.match(input.importMapOverride, {
      onNone: () => "",
      onSome: (pathname) => path.resolve(input.cwd, pathname),
    });

    for (const slug of input.slugs) {
      const configured = input.configFunctions[slug] ?? defaultManifestFunctionConfig;
      const override = input.configDeclaredFunctions[slug];
      const enabled = configured.enabled;
      const verifyJwt = Option.match(input.noVerifyJwtOverride, {
        onNone: () =>
          hasOwnKey(input.rawConfigFunctions[slug], "verify_jwt")
            ? configured.verify_jwt
            : undefined,
        onSome: (noVerifyJwt) => !noVerifyJwt,
      });

      const defaultEntrypoint = defaultFunctionEntrypoint(path, functionsDir, slug);
      const entrypoint =
        configured.entrypoint === undefined || configured.entrypoint.length === 0
          ? defaultEntrypoint
          : path.resolve(
              configured.entrypoint.startsWith(".") || !path.isAbsolute(configured.entrypoint)
                ? path.join(input.supabaseDir, configured.entrypoint)
                : configured.entrypoint,
            );

      let importMap = importMapOverride;
      if (importMap.length === 0) {
        let configuredImportMap = "";
        if (configured.import_map.length > 0) {
          configuredImportMap = path.resolve(
            configured.import_map.startsWith(".") || !path.isAbsolute(configured.import_map)
              ? path.join(input.supabaseDir, configured.import_map)
              : configured.import_map,
          );
        }

        if (
          configuredImportMap.length > 0 &&
          !(
            (override === undefined || override.import_map.length === 0) &&
            entrypoint !== defaultEntrypoint &&
            configuredImportMap === defaultFunctionImportMap(path, functionsDir, slug)
          )
        ) {
          importMap = configuredImportMap;
        } else {
          const functionDir = path.dirname(entrypoint);
          const denoJson = path.join(functionDir, "deno.json");
          const denoJsonc = path.join(functionDir, "deno.jsonc");
          const deprecatedImportMap = path.join(functionDir, "import_map.json");

          if (yield* isFile(denoJson)) {
            importMap = denoJson;
          } else if (yield* isFile(denoJsonc)) {
            importMap = denoJsonc;
          } else if (yield* isFile(deprecatedImportMap)) {
            importMap = deprecatedImportMap;
            seenDeprecatedImportMap.add(slug);
          } else if (fallbackExists) {
            if (fallbackExists) {
              importMap = fallbackImportMapPath;
              seenFallbackImportMap.add(slug);
            }
          }
        }
      }

      const staticFiles = configured.static_files.map((pathname) =>
        path.isAbsolute(pathname) ? pathname : path.join(input.supabaseDir, pathname),
      );

      resolved.push({
        slug,
        enabled,
        ...(verifyJwt === undefined ? {} : { verifyJwt }),
        entrypoint,
        importMap,
        staticFiles,
        env: configured.env,
      });
    }

    if (seenDeprecatedImportMap.size > 0) {
      yield* output.raw(
        `WARNING: Functions using deprecated import_map.json (please migrate to deno.json): ${[...seenDeprecatedImportMap].join(", ")}\n`,
        "stderr",
      );
    }

    if (seenFallbackImportMap.size > 0) {
      yield* output.raw(
        `WARNING: Functions using fallback import map: ${[...seenFallbackImportMap].join(", ")}\n`,
        "stderr",
      );
      yield* output.raw(
        `Please use recommended per function dependency declaration  ${IMPORT_MAP_GUIDE_URL}\n`,
        "stderr",
      );
    }

    return resolved;
  },
);

const deployViaApi = Effect.fn("functions.deploy.viaApi")(function* (
  projectRef: string,
  projectRoot: string,
  configs: ReadonlyArray<ResolvedDeployFunctionConfig>,
  api: ApiClient,
  jobs: number,
) {
  const output = yield* Output;
  const path = yield* Path.Path;
  yield* Effect.annotateCurrentSpan({ "function.count": configs.length, "deploy.jobs": jobs });

  // Uploaded file names and the server-recorded metadata paths are anchored at the workdir
  // (`projectRoot`), not at `sourceRoot`. The import-walk boundary (which files may be uploaded
  // at all) is intentionally wider, extending to the nearest git root, so files outside the
  // workdir but inside a monorepo can still deploy — those upload with `../`-relative names.
  const sourceRoot = yield* resolveFunctionsSourceRoot(projectRoot);
  const enabled = configs.filter((config) => config.enabled);
  for (const skipped of configs.filter((config) => !config.enabled)) {
    yield* output.raw(`Skipping disabled Function: ${skipped.slug}\n`, "stderr");
  }

  if (enabled.length === 0) {
    return yield* new NoFunctionsToDeployError({ message: "All Functions are up to date." });
  }

  const remoteBySlug = enabled.some((config) => config.verifyJwt === undefined)
    ? new Map((yield* listRemoteFunctions(api, projectRef)).map((fn) => [fn.slug, fn]))
    : new Map<string, RemoteFunction>();

  if (enabled.length === 1) {
    const config = enabled[0]!;
    yield* uploadFunctionSource(
      api,
      projectRef,
      sourceRoot,
      projectRoot,
      config,
      createSourceMetadata(path, projectRoot, config, remoteBySlug.get(config.slug)),
      false,
    );
    return;
  }

  // Each bundleOnly upload writes the bundle and bumps the remote version without persisting
  // metadata, which only the final bulk update does. Failing fast on the first upload error
  // strands that metadata remotely and makes every later deploy conflict, so run every upload to
  // completion, always persist what succeeded, then report the errors.
  const results = yield* Effect.forEach(
    enabled,
    (config) =>
      Effect.gen(function* () {
        yield* output.raw(`Deploying Function: ${config.slug}\n`, "stderr");
        return toBulkUpdateItem(
          yield* uploadFunctionSource(
            api,
            projectRef,
            sourceRoot,
            projectRoot,
            config,
            createSourceMetadata(path, projectRoot, config, remoteBySlug.get(config.slug)),
            true,
          ),
        );
      }).pipe(
        Effect.map((value) => ({ success: true as const, value })),
        Effect.catch((error) => Effect.succeed({ success: false as const, error })),
      ),
    { concurrency: jobs },
  );

  const deployed: BulkUpdateFunction[] = [];
  const messages: string[] = [];
  const causes: Array<Extract<(typeof results)[number], { readonly success: false }>["error"]> = [];
  for (const result of results) {
    if (result.success) {
      deployed.push(result.value);
    } else {
      messages.push(result.error.message);
      causes.push(result.error);
    }
  }

  if (deployed.length === 0) {
    return yield* Effect.fail(new AggregateError(causes, messages.join("\n")));
  }

  const updated = yield* bulkUpdateRemoteFunctions(api, projectRef, deployed).pipe(
    Effect.map(() => ({ success: true as const })),
    Effect.catch((error) => Effect.succeed({ success: false as const, error })),
  );
  if (!updated.success) {
    messages.push(updated.error.message);
    causes.push(updated.error);
  }
  if (messages.length > 0) {
    return yield* Effect.fail(new AggregateError(causes, messages.join("\n")));
  }
});

interface DeployViaDockerOptions {
  readonly projectId: string;
  readonly projectRef: string;
  readonly edgeRuntimeVersion: string;
  readonly functionsDir: string;
  readonly configs: ReadonlyArray<ResolvedDeployFunctionConfig>;
  readonly api: ApiClient;
  /** Already resolved (explicit flag > `SUPABASE_NETWORK_ID` > generated) — see the caller. */
  readonly networkMode: string;
  readonly verbose?: boolean;
  readonly styleEmphasis?: (text: string) => string;
  readonly projectEnvValues?: Readonly<Record<string, string>>;
}

const deployViaDocker = Effect.fn("functions.deploy.viaDocker")(function* (
  options: DeployViaDockerOptions,
) {
  const {
    projectId,
    projectRef,
    edgeRuntimeVersion,
    functionsDir,
    configs,
    api,
    networkMode,
    verbose = false,
    styleEmphasis = (text: string) => text,
    projectEnvValues,
  } = options;
  const output = yield* Output;
  yield* Effect.annotateCurrentSpan({ "function.count": configs.length });
  const remoteFunctions = yield* listRemoteFunctions(api, projectRef);

  const remoteBySlug = new Map(remoteFunctions.map((fn) => [fn.slug, fn]));
  const changed: BulkUpdateFunction[] = [];

  for (const config of configs) {
    if (!config.enabled) {
      yield* output.raw(`Skipping disabled Function: ${config.slug}\n`, "stderr");
      continue;
    }

    const bundled = yield* bundleFunctionWithDocker({
      projectId,
      edgeRuntimeVersion,
      functionsDir,
      config,
      networkMode,
      verbose,
      styleEmphasis,
      projectEnvValues,
    });
    const current = remoteBySlug.get(config.slug);
    if (
      current?.ezbr_sha256 === bundled.metadata.sha256 &&
      (bundled.metadata.verify_jwt === undefined ||
        current.verify_jwt === bundled.metadata.verify_jwt)
    ) {
      yield* output.raw(`No change found in Function: ${config.slug}\n`, "stderr");
      continue;
    }

    yield* output.raw(
      `Deploying Function: ${config.slug} (script size: ${humanSize(bundled.body.byteLength)})\n`,
      "stderr",
    );
    changed.push(
      toBulkUpdateItem(
        yield* upsertBundledFunction(api, projectRef, bundled, current !== undefined),
      ),
    );
  }

  if (changed.length > 1) {
    yield* bulkUpdateRemoteFunctions(api, projectRef, changed);
  }
});

const pruneFunctions = Effect.fn("functions.deploy.prune")(function* (
  projectRef: string,
  configs: ReadonlyArray<ResolvedDeployFunctionConfig>,
  api: ApiClient,
  yes: boolean,
) {
  const output = yield* Output;
  const remoteFunctions = yield* listRemoteFunctions(api, projectRef);
  const localSlugs = new Set(configs.map((config) => config.slug));
  const toDelete = remoteFunctions
    .filter((remote) => remote.status !== "REMOVED" && !localSlugs.has(remote.slug))
    .map((remote) => remote.slug);

  if (toDelete.length === 0) {
    yield* output.raw("No Functions to prune.\n", "stderr");
    return;
  }

  // Header, one ` • <bold slug>` line per function, and a trailing blank line before the [y/N]
  // choices. Routed through `promptYesNo` so `--yes`/`SUPABASE_YES` auto-confirms with the
  // stderr echo, and a non-TTY stdin still honors a piped `y`/`n` answer.
  const prompt = `${[
    "Do you want to delete the following Functions from your project?",
    ...toDelete.map((slug) => ` • ${bold(slug)}`),
  ].join("\n")}\n\n`;
  const confirmed = yield* promptYesNo(output, yes, prompt, false);
  if (!confirmed) {
    return yield* new FunctionDeployCancelledError({ message: CONTEXT_CANCELED_MESSAGE });
  }

  for (const slug of toDelete) {
    yield* output.raw(`Deleting Function: ${slug}\n`, "stderr");
    yield* deleteRemoteFunction(api, projectRef, slug);
  }
});

export const deployFunctions = Effect.fn("functions.deploy")(function* <
  ResolveError,
  ResolveRequirements,
>(
  flags: FunctionsDeployFlags,
  dependencies: DeployFunctionsDependencies<ResolveError, ResolveRequirements>,
) {
  const output = yield* Output;
  const path = yield* Path.Path;
  const styleIdentifier = dependencies.styleIdentifier ?? ((text: string) => text);
  const styleEmphasis = dependencies.styleEmphasis ?? ((text: string) => text);
  const commandPath = ["functions", "deploy"] as const;
  // Presence-based (true for `--use-api=false`, not just bare `--use-api`) — used only for
  // the mutual-exclusivity check below. Behavior branches (bundler routing, --jobs guard) key
  // off the resolved `flags.useApi` value instead.
  const explicitUseApi = hasExplicitLongFlag(dependencies.rawArgs, commandPath, "use-api");
  const explicitUseDocker = hasExplicitLongFlag(dependencies.rawArgs, commandPath, "use-docker");
  const explicitLegacyBundle = hasExplicitLongFlag(
    dependencies.rawArgs,
    commandPath,
    "legacy-bundle",
  );

  const changedModes = [
    explicitUseApi ? "use-api" : undefined,
    explicitUseDocker ? "use-docker" : undefined,
    explicitLegacyBundle ? "legacy-bundle" : undefined,
  ].filter((flag): flag is string => flag !== undefined);

  if (changedModes.length > 1) {
    return yield* new ConflictingFunctionDeployFlagsError({
      message: mutuallyExclusiveFlagsMessage(FUNCTIONS_DEPLOY_BUNDLER_MUTEX_GROUP, changedModes),
    });
  }

  // `--use-api=false` alone must not force the API path — it should fall through to whatever
  // `--use-docker`/`--legacy-bundle` already resolved to.
  const useLocalBundler = !flags.useApi && (flags.useDocker || flags.legacyBundle);
  const configuredJobs = Option.getOrElse(flags.jobs, () => 1);
  const jobs = configuredJobs === 0 ? 1 : configuredJobs;
  // Keyed on the resolved `--use-api` value alone, not on whether local bundling
  // (Docker/legacy-bundle) is in play.
  if (!flags.useApi && jobs > 1) {
    return yield* new FunctionDeployError({
      message: "--jobs must be used together with --use-api",
    });
  }

  const projectRef = yield* dependencies.resolveProjectRef(flags.projectRef);
  // `@supabase/config` merges the matching `[remotes.*]` block over the base config, so this
  // already reflects any remote function/edge_runtime overrides, through the same
  // `Config.Validate`/dotenv/env-override pipeline `start`/`stop`/`status` use (see
  // `functions-config.ts`). Must precede the slug-validation loop below, so an invalid
  // `config.toml` is reported ahead of a malformed slug when both are wrong.
  const context = yield* loadFunctionsCliConfig({
    projectRoot: dependencies.projectRoot,
    projectRef,
    localConfigLoader: dependencies.localConfigLoader,
  });

  if (flags.functionNames.length > 0) {
    for (const slug of flags.functionNames) {
      yield* validateDeploySlug(slug);
    }
  }

  const noVerifyJwtOverride = explicitBooleanFlag(
    dependencies.rawArgs,
    ["functions", "deploy"],
    "no-verify-jwt",
    flags.noVerifyJwt,
  );
  // `--debug=false` must resolve to `false` — a plain presence check would get that backwards
  // (same rule as `download.ts`'s own `--debug` read).
  const debugEnabled = explicitBooleanLongFlag(dependencies.rawArgs, "debug") ?? false;
  const deployConfig = context.loaded?.config;
  const edgeRuntimeVersion = yield* resolveEdgeRuntimeVersion(
    context.denoVersion,
    dependencies.edgeRuntimeVersion,
  );
  const configFunctions = yield* inferFunctionsManifest({
    cwd: dependencies.projectRoot,
    config: deployConfig,
    // Matches `loadFunctionsCliConfig`'s own options above: no ancestor directory is searched
    // past `dependencies.projectRoot` for either load, so they can never resolve two
    // different projects.
    search: false,
  });
  const configDeclaredFunctions = deployConfig?.functions ?? {};
  const rawConfigFunctions = rawFunctionConfigRecord(context.loaded?.document);
  yield* validateConfigFunctionSlugs(configDeclaredFunctions);
  const slugs =
    flags.functionNames.length > 0
      ? [...flags.functionNames]
      : yield* discoverFunctionSlugs(dependencies.projectRoot, configDeclaredFunctions);

  if (slugs.length === 0) {
    return yield* new NoFunctionsToDeployError({
      // Styling is text-mode only: in `--output-format json`/`stream-json` this message
      // lands in the structured error payload, which must stay free of ANSI escapes.
      message: `No Functions specified or found in ${
        output.format === "text" ? styleEmphasis(SUPABASE_FUNCTIONS_DIR) : SUPABASE_FUNCTIONS_DIR
      }`,
    });
  }

  const uniqueSlugs = [...new Set(slugs)];
  const configs = yield* resolveFunctionConfigs({
    slugs: uniqueSlugs,
    cwd: dependencies.flagCwd,
    projectRoot: dependencies.projectRoot,
    supabaseDir: dependencies.supabaseDir,
    configFunctions,
    configDeclaredFunctions,
    rawConfigFunctions,
    importMapOverride: flags.importMap,
    noVerifyJwtOverride,
  });
  const dashboardUrl = `${dependencies.dashboardUrl}/project/${projectRef}/functions`;

  const deployWithApi = deployViaApi(
    projectRef,
    dependencies.projectRoot,
    configs,
    dependencies.api,
    jobs,
  ).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error): error is NoFunctionsToDeployError => error instanceof NoFunctionsToDeployError,
      (error) =>
        (output.format === "text"
          ? output.raw(`${error.message}\n`, "stderr")
          : output.success(error.message, {
              project_ref: projectRef,
              functions: uniqueSlugs,
              dashboard_url: dashboardUrl,
            })
        ).pipe(Effect.as(false)),
    ),
  );

  const styleWarning = dependencies.styleWarning ?? ((text: string) => text);
  const deployed = useLocalBundler
    ? yield* Effect.gen(function* () {
        if (!(yield* isDockerRunning())) {
          yield* output.raw(`${styleWarning("WARNING:")} Docker is not running\n`, "stderr");
          return yield* deployWithApi;
        }

        // `lastExplicitLongFlagValue` preserves the "explicitly cleared" vs "never touched"
        // distinction `resolveDockerNetworkMode` needs — see that function's own doc comment.
        // `SUPABASE_NETWORK_ID` (env or project dotenv) is CLI-only.
        const networkMode = resolveDockerNetworkMode({
          explicit: lastExplicitLongFlagValue(dependencies.rawArgs, [], "network-id"),
          envOverride: supabaseEnvStringWithProjectFallback(
            "SUPABASE_NETWORK_ID",
            context.projectEnvValues,
          ),
          projectId: context.projectId,
        });
        yield* deployViaDocker({
          projectId: context.projectId,
          projectRef,
          edgeRuntimeVersion,
          functionsDir: path.join(dependencies.projectRoot, SUPABASE_FUNCTIONS_DIR),
          configs,
          api: dependencies.api,
          networkMode,
          verbose: debugEnabled,
          styleEmphasis,
          projectEnvValues: context.projectEnvValues,
        });
        return true;
      })
    : yield* deployWithApi;

  if (!deployed) {
    return;
  }

  if (output.format === "text") {
    // Joins the raw `slugs` list, not the deduped set, so `functions deploy foo foo` prints
    // "foo, foo".
    yield* output.raw(
      `Deployed Functions on project ${styleIdentifier(projectRef)}: ${slugs.join(", ")}\n`,
    );
    yield* output.raw(`You can inspect your deployment in the Dashboard: ${dashboardUrl}\n`);
  } else {
    yield* output.success("Deployed Functions.", {
      project_ref: projectRef,
      functions: uniqueSlugs,
      dashboard_url: dashboardUrl,
    });
  }

  if (flags.prune) {
    yield* pruneFunctions(projectRef, configs, dependencies.api, dependencies.yes ?? false);
  }
});
