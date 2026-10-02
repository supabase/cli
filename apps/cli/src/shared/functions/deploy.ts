import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- pure, synchronous path-string math (no I/O), the same convention as command-internal/path-containment.ts and docker-ids.ts.
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
import { Cause, Config, Duration, Effect, FileSystem, Option, Ref, Schedule, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { promptYesNo } from "../../command-internal/prompt-yes-no.ts";
import { bitbucketCloneDir } from "../../command-internal/bitbucket-pipeline.ts";
import { isPathContainedInRoot } from "../../command-internal/path-containment.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../output/errors.ts";
import { Output } from "../output/output.service.ts";
import { bold } from "../../command-internal/colors.ts";
import { viperEnvStringWithProjectFallback } from "../../command-internal/viper-env.ts";
import { findGitRootPath } from "../git/git-root.ts";
import {
  cobraMutuallyExclusiveErrorMessage,
  explicitBooleanLongFlag,
  hasExplicitLongFlag,
  lastExplicitLongFlagValue,
} from "../cli/cobra-flag-groups.ts";
import {
  edgeRuntimeImage,
  FUNCTIONS_BUNDLER_MUTEX_GROUP,
  invalidFunctionSlugDetail,
  validateFunctionSlugMessage,
} from "./functions.shared.ts";
import { slimImagesEnabled } from "../services/slim-images.ts";
import {
  ConflictingFunctionDeployFlagsError,
  FunctionAssetIsDirectoryError,
  FunctionAssetOutsideRootError,
  FunctionBundleFailedError,
  FunctionDeployCancelledError,
  FunctionDeployJobsRequiresApiError,
  FunctionImportMapParseError,
  FunctionImportNotDirectoryError,
  FunctionStaticPatternNoMatchError,
  InvalidFunctionDeploySlugError,
  NoFunctionsToDeployError,
} from "./deploy.errors.ts";
import {
  buildFunctionsDockerRunArgs,
  edgeRuntimeCacheVolume,
  ensureDockerNamedVolume,
  ensureDockerNetwork,
  isDockerRunning,
  type NativeFailure,
  nativeFailure,
  nativePlatformFailure,
  resolveDockerNetworkMode,
  resolveEdgeRuntimeVersion,
  resolveFunctionsDockerImage,
  runChildProcess,
  toDockerPath,
  toSlash,
} from "./functions-docker.ts";
import { loadFunctionsCliConfig, type FunctionsGoConfigCompat } from "./functions-config.ts";
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
   * `undefined` for library callers; the CLI injects
   * `functionsGoConfigCompat` so this file never imports the command tree
   * directly — see {@link FunctionsGoConfigCompat}.
   */
  readonly goConfigCompat: FunctionsGoConfigCompat | undefined;
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

const decodeFunctionListResponseSchema = Schema.decodeUnknownSync(
  Schema.Array(FunctionResponse_Output),
);
const decodeDeployFunctionResponseSchema = Schema.decodeUnknownSync(
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

function decodeDeployFunctionResponse(value: unknown): DeployFunctionResponse {
  return decodeDeployFunctionResponseSchema(
    omitNullableFields(value, nullableOptionalDeployFunctionFields),
  );
}

function decodeFunctionListResponse(value: unknown): ReadonlyArray<RemoteFunction> {
  const normalized = Array.isArray(value)
    ? value.map((item) => omitNullableFields(item, nullableOptionalFunctionListFields))
    : value;
  return decodeFunctionListResponseSchema(normalized);
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

function isDenoConfigFile(pathname: string) {
  const name = basename(pathname).toLowerCase();
  return name === "deno.json" || name === "deno.jsonc";
}

/**
 * Presence-based `Option.some(value)` when `--<flagName>` was passed
 * explicitly after `commandPath`, matching cobra's `Changed()`;
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
 * command tree (this file has no Go equivalent for the other two
 * labels either). Read back by `cleanupStartSecrets` so a later
 * `stop`/`rollbackStart` can reclaim this container's staged-secret
 * directory using its OWN workdir rather than the caller's cwd.
 */
export const dockerWorkdirLabel = "com.supabase.cli.workdir";
/**
 * The eszip bundler container receives only `NPM_CONFIG_REGISTRY` from the host environment.
 * `NPM_AUTH_TOKEN` is intentionally not forwarded, even though a caller might expect it to be.
 */
const dockerNpmEnvNames = ["NPM_CONFIG_REGISTRY"] as const;

function toBundledFileUrl(hostPath: string) {
  const url = new URL("file:///");
  url.pathname = toDockerPath(hostPath, { resolve }).replaceAll("%", "%25");
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

function toApiRelativePath(cwd: string, hostPath: string) {
  const resolved = resolve(hostPath);
  const relativePath = relative(cwd, resolved);
  return toSlash(relativePath.length > 0 ? relativePath : basename(resolved));
}

// Call sites always pass already-`realPath`-resolved, absolute candidates and
// roots, so the shared primitive's "both arguments must already be
// canonicalized" precondition always holds here.
function isContainedInAnyPath(roots: ReadonlyArray<string>, candidate: string) {
  return roots.some((root) => isPathContainedInRoot(root, candidate));
}

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

function fsErrorCode(error: PlatformError): string | undefined {
  const cause = error.reason.cause;
  return cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
}

/** Curried `nativePlatformFailure` for `Effect.mapError`, labeling the failing path once. */
const nativeFsError = (path: string) => (error: PlatformError) =>
  nativePlatformFailure(error, path);

const realpathIfExists = Effect.fn("functions.deploy.realpathIfExists")(function* (
  fs: FileSystem.FileSystem,
  pathname: string,
) {
  return yield* fs.realPath(resolve(pathname)).pipe(
    Effect.catchTag("PlatformError", (error) => {
      // ENOTDIR (a path routed through a file) is as nonexistent as ENOENT here.
      const code = fsErrorCode(error);
      if (error.reason._tag === "NotFound" || code === "ENOTDIR") {
        return Effect.succeed(resolve(pathname));
      }
      return Effect.fail(nativePlatformFailure(error, pathname));
    }),
  );
});

const resolveFunctionsSourceRoot = (projectRoot: string) =>
  findGitRootPath(projectRoot).pipe(Effect.map(Option.getOrElse(() => resolve(projectRoot))));

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

function resolveImportTarget(jsonPath: string, target: string) {
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

  const resolved = toSlash(join(dirname(jsonPath), target));
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
    return yield* new FunctionImportMapParseError({
      message: `failed to parse import map: expected ${fieldName} to be an object`,
    });
  }

  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") {
      return yield* new FunctionImportMapParseError({
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

  static fromUnknown = Effect.fnUntraced(function* (input: unknown) {
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
        return yield* new FunctionImportMapParseError({
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

  resolve(jsonPath: string) {
    const imports = Object.fromEntries(
      Object.entries(this.imports).map(([key, value]) => [
        key,
        resolveImportTarget(jsonPath, value),
      ]),
    );
    const scopes = Object.fromEntries(
      Object.entries(this.scopes).map(([scopeName, scopeValue]) => [
        resolveImportTarget(jsonPath, scopeName),
        Object.fromEntries(
          Object.entries(scopeValue).map(([key, value]) => [
            key,
            resolveImportTarget(jsonPath, value),
          ]),
        ),
      ]),
    );
    return new ImportMapFile(imports, scopes, this.importMapReference);
  }
}

/**
 * Shared by every JSONC import-map read (`loadImportMapFile`, `resolveImportMapAllowedRoots`).
 * Stays on raw `JSON.parse`, not `Schema.fromJsonString`: that combinator's own JSON-parse step
 * (`SchemaGetter.parseJson`) discards the native `SyntaxError` and reports a fixed
 * "a valid JSON string" message instead, which would change this error's existing text for a
 * malformed file.
 */
function decodeJsoncBytes(
  contents: Uint8Array,
): Effect.Effect<unknown, FunctionImportMapParseError> {
  return Effect.try({
    // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- see this function's own doc comment: Schema.fromJsonString discards the native SyntaxError this error's message needs
    try: () => JSON.parse(stripJsonComments(new TextDecoder().decode(contents))),
    catch: (cause) =>
      new FunctionImportMapParseError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}

// Explicit type annotation breaks the circular inference from the recursive
// `yield* loadImportMapFile(...)` call below.
const loadImportMapFile: <E = never>(
  fs: FileSystem.FileSystem,
  pathname: string,
  onRead?: (pathname: string, contents: Uint8Array) => Effect.Effect<void, E>,
  seen?: Set<string>,
) => Effect.Effect<ImportMapFile, FunctionImportMapParseError | NativeFailure | E> =
  Effect.fnUntraced(function* <E = never>(
    fs: FileSystem.FileSystem,
    pathname: string,
    onRead?: (pathname: string, contents: Uint8Array) => Effect.Effect<void, E>,
    seen: Set<string> = new Set<string>(),
  ) {
    const resolvedPath = resolve(pathname);
    if (seen.has(resolvedPath)) {
      return yield* new FunctionImportMapParseError({
        message: `cyclic import map reference: ${pathname}`,
      });
    }
    seen.add(resolvedPath);
    const contents = yield* fs.readFile(pathname).pipe(Effect.mapError(nativeFsError(pathname)));
    if (onRead !== undefined) {
      yield* onRead(pathname, contents);
    }
    const parsed = yield* decodeJsoncBytes(contents);
    const importMap = (yield* ImportMapFile.fromUnknown(parsed)).resolve(toSlash(pathname));
    if (isDenoConfigFile(pathname) && importMap.isReference()) {
      const nestedPath = join(dirname(pathname), importMap.importMapReference);
      return yield* loadImportMapFile(fs, nestedPath, onRead, seen);
    }
    return importMap;
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
    // ends with "/" — see go-cli-divergences.md for why this differs from a naive prefix match.
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

const walkImportPaths = Effect.fnUntraced(function* <EFile = never>(
  fs: FileSystem.FileSystem,
  importMap: ImportMapFile,
  srcPath: string,
  allowedRoots: ReadonlyArray<string>,
  displayRoot: string,
  onFile: (pathname: string, contents: Uint8Array) => Effect.Effect<void, EFile>,
  onWarning: (message: string) => Effect.Effect<void>,
) {
  const seen = new Set<string>();
  const queue = [toSlash(srcPath)];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);

    const maybeContents: Option.Option<Uint8Array> = yield* Effect.gen(function* () {
      const resolvedCurrent = yield* fs.realPath(resolve(current));
      if (!isContainedInAnyPath(allowedRoots, resolvedCurrent)) {
        yield* onWarning(`WARN: Skipping import path outside source root: ${current}\n`);
        return Option.none<Uint8Array>();
      }
      return Option.some(yield* fs.readFile(resolvedCurrent));
    }).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.gen(function* () {
          if (error.reason._tag === "NotFound") {
            const message = `failed to read file: open ${toApiRelativePath(displayRoot, current)}: no such file or directory`;
            yield* onWarning(`WARN: ${message}\n`);
            return Option.none<Uint8Array>();
          }
          // An ENOTDIR (import path routed through a file) gets a classified, user-facing message
          // instead of an unhandled raw Node error, so telemetry books it as user-fixable config.
          if (fsErrorCode(error) === "ENOTDIR") {
            return yield* new FunctionImportNotDirectoryError({
              message: `failed to read file: open ${toApiRelativePath(displayRoot, current)}: not a directory`,
            });
          }
          return yield* nativePlatformFailure(error, current);
        }),
      ),
    );

    if (Option.isNone(maybeContents)) {
      continue;
    }
    const contents = maybeContents.value;

    yield* onFile(current, contents);
    const text = new TextDecoder().decode(contents);
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
        modulePath = toSlash(join(dirname(current), modulePath));
      }

      const resolvedModule = resolve(modulePath);
      const containmentPath = yield* realpathIfExists(fs, resolvedModule);
      if (!isContainedInAnyPath(allowedRoots, containmentPath)) {
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

function defaultFunctionEntrypoint(functionsDir: string, slug: string) {
  return join(functionsDir, slug, "index.ts");
}

function defaultFunctionImportMap(functionsDir: string, slug: string) {
  return join(functionsDir, slug, "deno.json");
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

function globBaseDirectory(pattern: string) {
  const normalized = toSlash(pattern);
  if (!hasGlobMeta(normalized)) {
    return dirname(normalized);
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

// Node's native recursive `readdir` yields every intermediate directory alongside leaf files,
// relative to `root`.
const listPathsRecursive = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, root: string) {
  const resolvedRoot = resolve(root);
  const entries = yield* fs.readDirectory(resolvedRoot, { recursive: true });
  return entries.map((entry) => join(resolvedRoot, entry));
});

const expandStaticPattern = Effect.fn("functions.deploy.expandStaticPattern")(function* (
  fs: FileSystem.FileSystem,
  pattern: string,
) {
  const noMatch = () =>
    new FunctionStaticPatternNoMatchError({ message: `no files matched pattern: ${pattern}` });

  if (!hasGlobMeta(pattern)) {
    const exists = yield* fs.stat(pattern).pipe(
      Effect.as(true),
      Effect.catchTag("PlatformError", () => Effect.succeed(false)),
    );
    if (!exists) {
      return yield* noMatch();
    }
    return [pattern];
  }

  const baseDir = globBaseDirectory(pattern);
  // `globToRegExp` builds its result with `new RegExp(...)`, which throws a native `SyntaxError`
  // for an invalid bracket expression (e.g. `[z-a]`); keep that as a typed failure the recovery
  // below can catch, not a defect that would bypass it.
  const matcher = yield* Effect.try({
    try: () => globToRegExp(toSlash(resolve(pattern))),
    catch: (cause) => nativeFailure(cause),
  });
  const candidates = yield* listPathsRecursive(fs, baseDir).pipe(
    Effect.catchTag(
      "PlatformError",
      (error): Effect.Effect<never, FunctionStaticPatternNoMatchError | NativeFailure> =>
        error.reason._tag === "NotFound"
          ? Effect.fail(noMatch())
          : Effect.fail(nativePlatformFailure(error, baseDir)),
    ),
  );
  const matches = candidates.filter((candidate) => matcher.test(toSlash(resolve(candidate))));
  if (matches.length === 0) {
    return yield* noMatch();
  }
  return matches;
});

const forEachLocalImportMapTarget = Effect.fnUntraced(function* <E = never>(
  importMap: ImportMapFile,
  onTarget: (pathname: string, kind: "import" | "scope") => Effect.Effect<void, E>,
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

const walkLocalImportMapTargetImports = Effect.fnUntraced(function* <EFile = never>(
  fs: FileSystem.FileSystem,
  importMap: ImportMapFile,
  pathname: string,
  allowedRoots: ReadonlyArray<string>,
  displayRoot: string,
  onFile: (pathname: string, contents: Uint8Array) => Effect.Effect<void, EFile>,
  onWarning: (message: string) => Effect.Effect<void>,
) {
  const info = yield* fs.stat(pathname).pipe(Effect.mapError(nativeFsError(pathname)));
  if (info.type === "Directory") {
    return;
  }
  yield* walkImportPaths(fs, importMap, pathname, allowedRoots, displayRoot, onFile, onWarning);
});

const isFile = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, pathname: string) {
  return yield* fs.stat(pathname).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.catchTag("PlatformError", () => Effect.succeed(false)),
  );
});

const resolveImportMapAllowedRoots = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  projectRoot: string,
  importMapPath: string,
) {
  const realProjectRoot = yield* fs
    .realPath(projectRoot)
    .pipe(Effect.mapError(nativeFsError(projectRoot)));
  const allowedRoots = [realProjectRoot];
  if (importMapPath.length === 0) {
    return allowedRoots;
  }

  const realImportMapPath = yield* fs
    .realPath(importMapPath)
    .pipe(Effect.mapError(nativeFsError(importMapPath)));
  if (!isPathContainedInRoot(realProjectRoot, realImportMapPath)) {
    allowedRoots.push(dirname(realImportMapPath));
  }
  if (isDenoConfigFile(importMapPath)) {
    const contents = yield* fs
      .readFile(importMapPath)
      .pipe(Effect.mapError(nativeFsError(importMapPath)));
    const parsed = yield* decodeJsoncBytes(contents);
    const importMap = yield* ImportMapFile.fromUnknown(parsed);
    if (importMap.importMapReference.length > 0) {
      const referencedPath = join(dirname(importMapPath), importMap.importMapReference);
      const referencedImportMapPath = yield* fs
        .realPath(referencedPath)
        .pipe(Effect.mapError(nativeFsError(referencedPath)));
      if (!isPathContainedInRoot(realProjectRoot, referencedImportMapPath)) {
        allowedRoots.push(dirname(referencedImportMapPath));
      }
    }
  }
  return allowedRoots;
});

const writeSourceDeployForm = Effect.fn("functions.deploy.writeSourceDeployForm")(function* (
  fs: FileSystem.FileSystem,
  sourceRoot: string,
  workdir: string,
  config: ResolvedDeployFunctionConfig,
  outputRaw: (text: string) => Effect.Effect<void, never>,
) {
  const files: Array<File> = [];
  const hasImportMap = config.importMap.length > 0;
  const realSourceRoot = yield* fs
    .realPath(sourceRoot)
    .pipe(Effect.mapError(nativeFsError(sourceRoot)));
  const importMapAllowedRoots = yield* resolveImportMapAllowedRoots(
    fs,
    sourceRoot,
    config.importMap,
  );
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
    const relativePath = toApiRelativePath(workdir, pathname);
    if (hasParentPathSegment(relativePath)) {
      return yield* new FunctionAssetOutsideRootError({
        message: `failed to read file: open ${relativePath}: invalid argument`,
      });
    }
    yield* outputRaw(`Uploading asset (${config.slug}): ${relativePath}\n`);
    files.push(new File([contents], relativePath));
  });

  const uploadAsset = Effect.fnUntraced(function* (pathname: string, contents: Uint8Array) {
    const realPathname = yield* fs
      .realPath(pathname)
      .pipe(Effect.mapError(nativeFsError(pathname)));
    if (!isPathContainedInRoot(realSourceRoot, realPathname)) {
      return yield* new FunctionAssetOutsideRootError({
        message: `refusing to upload asset outside source root: ${pathname}`,
      });
    }
    yield* appendAsset(pathname, contents, realPathname);
  });

  const uploadImportMapAsset = Effect.fnUntraced(function* (
    pathname: string,
    contents: Uint8Array,
  ) {
    const realPathname = yield* fs
      .realPath(pathname)
      .pipe(Effect.mapError(nativeFsError(pathname)));
    if (!isContainedInAnyPath(importMapAllowedRoots, realPathname)) {
      return yield* new FunctionAssetOutsideRootError({
        message: `refusing to upload import map outside allowed roots: ${pathname}`,
      });
    }
    yield* appendAsset(pathname, contents, realPathname);
  });

  const uploadImportMapTargetAsset = Effect.fnUntraced(function* (
    pathname: string,
    contents: Uint8Array,
  ) {
    const realPathname = yield* fs
      .realPath(pathname)
      .pipe(Effect.mapError(nativeFsError(pathname)));
    if (!isContainedInAnyPath(importMapAllowedRoots, realPathname)) {
      yield* outputRaw(`WARN: Skipping import path outside source root: ${pathname}\n`);
      return;
    }
    yield* appendAsset(pathname, contents, realPathname);
  });

  const uploadScopeTarget = Effect.fnUntraced(function* (pathname: string) {
    const outcome = yield* fs.realPath(pathname).pipe(
      Effect.flatMap((resolvedPath) =>
        fs.stat(pathname).pipe(Effect.map((pathInfo) => Option.some({ resolvedPath, pathInfo }))),
      ),
      Effect.catchTag("PlatformError", (error) =>
        fsErrorCode(error) === "ENOTDIR"
          ? Effect.succeed(
              Option.none<{
                readonly resolvedPath: string;
                readonly pathInfo: FileSystem.File.Info;
              }>(),
            )
          : Effect.fail(nativePlatformFailure(error, pathname)),
      ),
    );
    if (Option.isNone(outcome)) {
      yield* outputRaw(`WARN: Skipping import map target that is not a directory: ${pathname}\n`);
      return;
    }
    const { resolvedPath, pathInfo } = outcome.value;
    if (!isContainedInAnyPath(importMapAllowedRoots, resolvedPath)) {
      yield* outputRaw(`WARN: Skipping import path outside source root: ${pathname}\n`);
      return;
    }
    if (pathInfo.type !== "Directory") {
      const contents = yield* fs.readFile(pathname).pipe(Effect.mapError(nativeFsError(pathname)));
      yield* uploadImportMapTargetAsset(pathname, contents);
      yield* walkLocalImportMapTargetImports(
        fs,
        importMap,
        pathname,
        importMapAllowedRoots,
        workdir,
        uploadImportMapTargetAsset,
        outputRaw,
      );
      return;
    }
    const nestedPaths = yield* listPathsRecursive(fs, pathname).pipe(
      Effect.mapError(nativeFsError(pathname)),
    );
    for (const nestedPath of nestedPaths) {
      const nestedInfo = yield* fs
        .stat(nestedPath)
        .pipe(Effect.mapError(nativeFsError(nestedPath)));
      if (nestedInfo.type === "Directory") {
        continue;
      }
      const resolvedNestedPath = yield* fs
        .realPath(nestedPath)
        .pipe(Effect.mapError(nativeFsError(nestedPath)));
      if (!isContainedInAnyPath(importMapAllowedRoots, resolvedNestedPath)) {
        yield* outputRaw(`WARN: Skipping import path outside source root: ${nestedPath}\n`);
        continue;
      }
      const nestedContents = yield* fs
        .readFile(nestedPath)
        .pipe(Effect.mapError(nativeFsError(nestedPath)));
      yield* uploadImportMapTargetAsset(nestedPath, nestedContents);
    }
  });

  if (hasImportMap) {
    yield* loadImportMapFile(fs, config.importMap, uploadImportMapAsset);
  }

  for (const pattern of config.staticFiles) {
    // Every typed expansion failure (no match, an unreadable directory, ...) is warned and
    // skipped. Interruptions and defects are untouched — only the two declared tags are caught.
    const warnAndSkip = (error: { readonly message: string }) =>
      outputRaw(`WARN: ${error.message}\n`).pipe(Effect.as(undefined));
    const files: ReadonlyArray<string> | undefined = yield* expandStaticPattern(fs, pattern).pipe(
      Effect.catchTags({
        FunctionStaticPatternNoMatchError: warnAndSkip,
        NativeFailure: warnAndSkip,
      }),
    );
    if (files === undefined) {
      continue;
    }
    for (const pathname of files) {
      const info = yield* fs.stat(pathname).pipe(Effect.mapError(nativeFsError(pathname)));
      if (info.type === "Directory") {
        return yield* new FunctionAssetIsDirectoryError({
          message: `file path is a directory: ${pathname}`,
        });
      }
      const contents = yield* fs.readFile(pathname).pipe(Effect.mapError(nativeFsError(pathname)));
      yield* uploadAsset(pathname, contents);
    }
  }

  const importMap = hasImportMap
    ? yield* loadImportMapFile(fs, config.importMap)
    : new ImportMapFile();
  yield* walkImportPaths(
    fs,
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
  workdir: string,
  config: ResolvedDeployFunctionConfig,
  remote?: RemoteFunction,
): SourceDeployMetadata {
  const verifyJwt = config.verifyJwt ?? remote?.verify_jwt;
  return {
    name: config.slug,
    ...(verifyJwt === undefined ? {} : { verify_jwt: verifyJwt }),
    entrypoint_path: toApiRelativePath(workdir, config.entrypoint),
    import_map_path:
      config.importMap.length > 0 ? toApiRelativePath(workdir, config.importMap) : "",
    static_patterns: config.staticFiles.map((pathname) => toApiRelativePath(workdir, pathname)),
  };
}

function createBundledMetadata(
  config: ResolvedDeployFunctionConfig,
  sha256: string,
): BundledDeployMetadata {
  return {
    name: config.slug,
    ...(config.verifyJwt === undefined ? {} : { verify_jwt: config.verifyJwt }),
    entrypoint_path: toBundledFileUrl(config.entrypoint),
    sha256,
    ...(config.importMap.length > 0 ? { import_map_path: toBundledFileUrl(config.importMap) } : {}),
    ...(config.staticFiles.length > 0
      ? { static_patterns: config.staticFiles.map(toBundledFileUrl) }
      : {}),
  };
}

function sanitizeDockerBinds(
  binds: ReadonlyArray<DockerBind>,
  functionsDir: string,
  outputDir: string,
) {
  const normalizedFunctionsDir = `${toSlash(resolve(functionsDir))}/`;
  const normalizedOutputDir = `${toSlash(resolve(outputDir))}/`;
  const seen = new Set<string>();
  const result: DockerBind[] = [];

  for (const bind of binds) {
    const normalizedHostPath = toSlash(resolve(bind.hostPath));
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

export const buildDockerBinds = (
  projectId: string,
  functionsDir: string,
  outputDir: string,
  config: ResolvedDeployFunctionConfig,
  options: DockerBindsOptions = {},
) =>
  resolveFunctionsSourceRoot(resolve(functionsDir, "..", "..")).pipe(
    Effect.flatMap((sourceRoot) =>
      Effect.flatMap(FileSystem.FileSystem, (fs) =>
        buildDockerBindsWithin(fs, sourceRoot, projectId, functionsDir, outputDir, config, options),
      ),
    ),
  );

const buildDockerBindsWithin = Effect.fn("functions.deploy.buildDockerBinds")(function* (
  fs: FileSystem.FileSystem,
  sourceRoot: string,
  projectId: string,
  functionsDir: string,
  outputDir: string,
  config: ResolvedDeployFunctionConfig,
  options: DockerBindsOptions,
) {
  const hostFunctionsDir = resolve(functionsDir);
  const hostOutputDir = resolve(outputDir);
  const realSourceRoot = yield* fs
    .realPath(sourceRoot)
    .pipe(Effect.mapError(nativeFsError(sourceRoot)));
  const resolvedAdditionalRoots = yield* Effect.forEach(
    options.additionalModuleRoots ?? [],
    (root) => fs.realPath(root).pipe(Effect.option),
    { concurrency: "unbounded" },
  );
  const moduleRoots = [
    realSourceRoot,
    ...resolvedAdditionalRoots.flatMap((root) => (Option.isSome(root) ? [root.value] : [])),
  ];
  const importMapAllowedRoots = yield* resolveImportMapAllowedRoots(
    fs,
    sourceRoot,
    config.importMap,
  );
  const binds: DockerBind[] = [
    {
      hostPath: hostFunctionsDir,
      containerPath: toDockerPath(hostFunctionsDir, { resolve }),
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
      containerPath: toDockerPath(hostOutputDir, { resolve }),
      mode: "rw",
      externalScope: false,
    });
  }

  const onWarning = options.onWarning;
  const warn = (message: string) => (onWarning === undefined ? Effect.void : onWarning(message));
  const extraBinds: DockerBind[] = [];
  const explicitScopeBinds = new Map<string, DockerBind>();
  // Left as an untyped `PlatformError`, not wrapped into `NativeFailure`: the only caller that
  // inspects a failure here — the scope-target walk below — classifies ENOTDIR/ENOENT off the
  // platform tag.
  const appendBindWithinRoots = Effect.fnUntraced(function* (
    roots: ReadonlyArray<string>,
    pathname: string,
  ) {
    const hostPath = yield* fs.realPath(pathname);
    const contained = isContainedInAnyPath(roots, hostPath);
    if (contained) {
      extraBinds.push({
        hostPath,
        containerPath: toDockerPath(hostPath, { resolve }),
        mode: "ro",
        externalScope: false,
      });
    }
    return { hostPath, contained };
  });
  const appendProjectBind = (pathname: string, _contents: Uint8Array) =>
    appendBindWithinRoots([realSourceRoot], pathname).pipe(Effect.asVoid);
  const appendModuleBind = (pathname: string, _contents: Uint8Array) =>
    appendBindWithinRoots(moduleRoots, pathname).pipe(Effect.asVoid);
  const appendImportMapBind = (pathname: string, _contents: Uint8Array) =>
    appendBindWithinRoots(importMapAllowedRoots, pathname).pipe(Effect.asVoid);
  const importMap =
    config.importMap.length > 0
      ? yield* loadImportMapFile(fs, config.importMap, appendImportMapBind)
      : new ImportMapFile();
  yield* walkImportPaths(
    fs,
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
      const isDirectory = (yield* fs.stat(target)).type === "Directory";
      if (!contained && kind === "scope") {
        const scopeBind: DockerBind = {
          hostPath,
          containerPath: toDockerPath(target, { resolve }),
          mode: "ro",
          externalScope: true,
        };
        explicitScopeBinds.set(formatDockerBind(scopeBind), scopeBind);
      }
      if (isDirectory) {
        return;
      }
      yield* walkLocalImportMapTargetImports(
        fs,
        importMap,
        target,
        importMapAllowedRoots,
        sourceRoot,
        appendImportMapBind,
        () => Effect.void,
      );
    }).pipe(
      Effect.catchTag("PlatformError", (error) => {
        // ENOTDIR (a trailing-slash value routed through a file) is never a
        // walkable target regardless of caller: an import that actually
        // reaches through that file still fails via the walker's
        // FunctionImportNotDirectoryError.
        if (fsErrorCode(error) === "ENOTDIR") {
          return warn(`WARN: Skipping import map target that is not a directory: ${target}\n`);
        }
        if (options.skipMissingImportMapTargets === true && error.reason._tag === "NotFound") {
          return warn(`WARN: Skipping missing import map target: ${target}\n`);
        }
        return Effect.fail(nativePlatformFailure(error, target));
      }),
    ),
  );
  for (const pattern of config.staticFiles) {
    // Any expansion failure (no match, unreadable directory, ...) is silently skipped here,
    // unlike the API-upload path's warned skip.
    const files = yield* expandStaticPattern(fs, pattern).pipe(Effect.option);
    if (Option.isNone(files)) {
      continue;
    }
    for (const pathname of files.value) {
      const info = yield* fs.stat(pathname).pipe(Effect.mapError(nativeFsError(pathname)));
      if (info.type === "Directory") {
        return yield* new FunctionAssetIsDirectoryError({
          message: `file path is a directory: ${pathname}`,
        });
      }
      yield* appendProjectBind(pathname, new Uint8Array());
    }
  }

  const sanitizedExtraBinds = sanitizeDockerBinds(extraBinds, hostFunctionsDir, hostOutputDir);
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

function shouldUseDenoJsonDiscovery(entrypoint: string, importMap: string) {
  return isDenoConfigFile(importMap) && dirname(importMap) === dirname(entrypoint);
}

const shouldUsePackageJsonDiscovery = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  entrypoint: string,
  importMap: string,
) {
  if (importMap.length > 0) {
    return false;
  }
  return yield* fs.stat(join(dirname(entrypoint), "package.json")).pipe(
    Effect.as(true),
    Effect.catchTag("PlatformError", () => Effect.succeed(false)),
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
  yield* output.raw(`Bundling Function: ${styleEmphasis(config.slug)}\n`, "stderr");

  const outputRoot = resolve(functionsDir, "..", ".temp");
  yield* fs
    .makeDirectory(outputRoot, { recursive: true })
    .pipe(Effect.mapError(nativeFsError(outputRoot)));
  // A generator `finally` does not run when a yielded effect fails or is interrupted.
  return yield* Effect.acquireUseRelease(
    fs
      .makeTempDirectory({ directory: outputRoot, prefix: `.supabase-output-${config.slug}-` })
      .pipe(Effect.mapError(nativeFsError(outputRoot))),
    (outputDir) =>
      Effect.gen(function* () {
        // Go passes 0777 to MkdirAll, which Windows ignores. Calling chmod separately
        // adds an NTFS WRITE_ATTRIBUTES requirement that the Go CLI does not have.
        if (shouldChmodBundleOutputDirectory(process.platform)) {
          yield* fs.chmod(outputDir, 0o777).pipe(Effect.mapError(nativeFsError(outputDir)));
        }
        const outputPath = join(outputDir, "output.eszip");
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
        if (!(yield* shouldUsePackageJsonDiscovery(fs, config.entrypoint, config.importMap))) {
          env.push("DENO_NO_PACKAGE_JSON=1");
        }
        env.push(...dockerNpmEnv());

        const containerArgs = [
          "bundle",
          "--entrypoint",
          toDockerPath(config.entrypoint, { resolve }),
          "--output",
          toDockerPath(outputPath, { resolve }),
        ];
        if (
          config.importMap.length > 0 &&
          !shouldUseDenoJsonDiscovery(config.entrypoint, config.importMap)
        ) {
          containerArgs.push("--import-map", toDockerPath(config.importMap, { resolve }));
        }
        for (const staticFile of config.staticFiles) {
          containerArgs.push("--static", toDockerPath(staticFile, { resolve }));
        }
        const debugEnv = yield* Config.option(Config.string("DEBUG"));
        if (verbose || Option.contains(debugEnv, "true")) {
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
          workingDir: toDockerPath(resolve(functionsDir, "..", ".."), { resolve }),
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
          return yield* new FunctionBundleFailedError({
            message: `failed to bundle function: exit ${result.exitCode}`,
          });
        }

        const eszip = yield* fs.readFile(outputPath).pipe(
          Effect.mapError(
            (error) =>
              new FunctionBundleFailedError({
                message: `failed to open eszip: ${nativePlatformFailure(error, outputPath).message}`,
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
          metadata: createBundledMetadata(config, hash),
          body: compressed,
        } satisfies BundledFunction;
      }),
    (outputDir) =>
      fs
        .remove(outputDir, { recursive: true, force: true })
        .pipe(Effect.orElseSucceed(() => undefined)),
  );
});

// Transient-API bound shared by the list/bulk-update retry policies below: 3 retries (4 attempts
// total) with a 1s-base exponential backoff.
const transientApiRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.upTo({ times: 3 }),
);

// Same 3-retry bound as `transientApiRetrySchedule`, with a 500ms base for `upsertBundledFunction`.
const upsertRetrySchedule = Schedule.exponential("500 millis").pipe(Schedule.upTo({ times: 3 }));

/** Retries a transport-ish failure or a 5xx/429 status; a decode failure or other 4xx is terminal. */
function isRetryableFunctionsApiError(
  error:
    | FunctionsApiStatusError
    | FunctionsApiTransportError
    | SupabaseApiInputError
    | HttpBody.HttpBodyError,
): boolean {
  return (
    !(error instanceof FunctionsApiStatusError) ||
    (error.decode !== true && (error.status >= 500 || error.status === 429))
  );
}

const listRemoteFunctions = Effect.fn("functions.deploy.listRemoteFunctions")(function* (
  api: ApiClient,
  projectRef: string,
) {
  const attempt = Effect.gen(function* () {
    const response = yield* api
      .executeRaw(operationDefinitions.v1ListAllFunctions, { ref: projectRef })
      .pipe(Effect.mapError((error) => mapTransportError("failed to list functions", error)));
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    if (response.status === 200) {
      // A 200 whose body is not the expected JSON is an API-response problem,
      // not a transport failure — surface it via FunctionsApiStatusError so it
      // classifies as api_status rather than network.
      return yield* Effect.try({
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- Schema.fromJsonString discards the native SyntaxError on malformed JSON (see decodeJsoncBytes); this raw JSON.parse keeps that message for the decode-error branch below
        try: () => decodeFunctionListResponse(JSON.parse(body)),
        catch: (error) =>
          new FunctionsApiStatusError({
            status: response.status,
            message: `failed to read functions list: ${error instanceof Error ? error.message : String(error)}`,
            decode: true,
          }),
      });
    }
    return yield* new FunctionsApiStatusError({
      status: response.status,
      message: `unexpected list functions status ${response.status}: ${body}`,
    });
  });

  return yield* attempt.pipe(
    Effect.retry({ schedule: transientApiRetrySchedule, while: isRetryableFunctionsApiError }),
  );
});

function headerValue(headers: Readonly<Record<string, string | undefined>>, name: string) {
  return headers[name.toLowerCase()] ?? headers[name];
}

function parseRateLimitDelay(value: string | undefined, nowMillis: number): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) {
    return Math.max(seconds, 0) * 1_000;
  }
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.max(timestamp - nowMillis, 0);
  }
  return undefined;
}

/** `nowMillis` comes from the caller's `Schedule`/`Clock` metadata, never read from the system clock here. */
function rateLimitDelayMillis(
  headers: Readonly<Record<string, string | undefined>>,
  attempt: number,
  nowMillis: number,
) {
  return (
    parseRateLimitDelay(headerValue(headers, "retry-after"), nowMillis) ??
    parseRateLimitDelay(headerValue(headers, "x-ratelimit-reset"), nowMillis) ??
    1_000 * 2 ** Math.min(attempt, 5)
  );
}

function rateLimitDelayText(milliseconds: number) {
  return `${Math.round(milliseconds / 1_000)}s`;
}

interface RateLimitableResponse<A> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Effect.Effect<A, Error>;
}

const rateLimitedRequest = Effect.fnUntraced(function* <A>(
  action: string,
  request: () => Effect.Effect<RateLimitableResponse<A>, Error>,
) {
  const output = yield* Output;
  // Repeats on a 429, reporting the exact header- or backoff-derived delay through `Schedule`'s
  // own metadata.
  const schedule = Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<RateLimitableResponse<A>>) => {
      const previousAttempts = meta.attempt - 1;
      if (meta.input.status !== 429 || previousAttempts >= DEPLOY_RATE_LIMIT_MAX_RETRIES) {
        return Cause.done(meta.input);
      }
      const delayMs = rateLimitDelayMillis(meta.input.headers, previousAttempts, meta.now);
      return output
        .raw(
          `Rate limit exceeded while ${action}. Retrying in ${rateLimitDelayText(delayMs)}.\n`,
          "stderr",
        )
        .pipe(
          Effect.as([meta.input, Duration.millis(delayMs)] as [
            RateLimitableResponse<A>,
            Duration.Duration,
          ]),
        );
    }),
  );
  return yield* request().pipe(Effect.repeat({ schedule }));
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
  const fs = yield* FileSystem.FileSystem;
  const files = yield* writeSourceDeployForm(fs, sourceRoot, workdir, config, (text) =>
    output.raw(text, "stderr"),
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
  return yield* Effect.try({
    // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- Schema.fromJsonString discards the native SyntaxError on malformed JSON (see decodeJsoncBytes); this raw JSON.parse keeps that message for the decode-error branch below
    try: () => decodeDeployFunctionResponse(JSON.parse(body)),
    catch: (error) =>
      new FunctionsApiStatusError({
        status: response.status,
        message: `failed to read deploy response: ${error instanceof Error ? error.message : String(error)}`,
        decode: true,
      }),
  });
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
  const attempt = Effect.gen(function* () {
    const response = yield* rateLimitedRequest("bulk updating functions", () =>
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
    );
    if (response.status === 200) {
      return;
    }
    const body = yield* response.body;
    return yield* new FunctionsApiStatusError({
      status: response.status,
      message: `unexpected bulk update status ${response.status}: ${body}`,
    });
  });

  yield* attempt.pipe(
    Effect.retry({
      schedule: transientApiRetrySchedule,
      while: (error) => !(error instanceof FunctionsApiStatusError) || error.status >= 500,
    }),
  );
});

const upsertBundledFunction = Effect.fn("functions.deploy.upsertFunction")(function* (
  api: ApiClient,
  projectRef: string,
  bundled: BundledFunction,
  exists: boolean,
) {
  const shouldUpdateRef = yield* Ref.make(exists);

  const attempt = Effect.gen(function* () {
    const shouldUpdate = yield* Ref.get(shouldUpdateRef);
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
      Effect.mapError((error) => mapTransportError(`failed to ${action} function`, error)),
    );

    const expectedStatus = shouldUpdate ? 200 : 201;
    if (response.status === expectedStatus) {
      // A success status with a malformed / unexpected JSON body is an
      // API-response problem, not a transport failure — surface it via
      // FunctionsApiStatusError so it classifies as api_status not network.
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* Effect.try({
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- Schema.fromJsonString discards the native SyntaxError on malformed JSON (see decodeJsoncBytes); this raw JSON.parse keeps that message for the decode-error branch below
        try: () => decodeDeployFunctionResponse(JSON.parse(body)),
        catch: (error) =>
          new FunctionsApiStatusError({
            status: response.status,
            message: `failed to read function response: ${error instanceof Error ? error.message : String(error)}`,
            decode: true,
          }),
      });
    }

    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    let nextShouldUpdate = shouldUpdate;
    if (!shouldUpdate && body.includes("Duplicated function slug")) {
      nextShouldUpdate = true;
      yield* Ref.set(shouldUpdateRef, true);
    }
    return yield* new FunctionsApiStatusError({
      status: response.status,
      message: `unexpected ${action} function status ${response.status}: ${body}`,
      notFoundIsInvalidInput: nextShouldUpdate,
    });
  });

  // Every failure here is retried up to the bound, except a decode failure on an
  // already-successful status: an unexpected status can still flip `shouldUpdateRef` (a
  // `Duplicated function slug` 4xx) and succeed on the retried request, but retrying a malformed
  // 200/201 body would only repeat the same write.
  return yield* attempt.pipe(
    Effect.retry({
      schedule: upsertRetrySchedule,
      while: (error) => !(error instanceof FunctionsApiStatusError) || error.decode !== true,
    }),
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
  const functionsDir = join(projectRoot, SUPABASE_FUNCTIONS_DIR);
  const slugs: string[] = [];

  const entries = yield* fs.readDirectory(functionsDir).pipe(
    Effect.map(Option.some),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed(Option.none<ReadonlyArray<string>>())
        : Effect.fail(nativePlatformFailure(error, functionsDir)),
    ),
  );
  if (Option.isSome(entries)) {
    // The platform `FileSystem` has no Dirent-returning `readdir`, so there's no cheap
    // `isDirectory() || isSymbolicLink()` filter to check first; the entrypoint check below
    // already requires `<slug>/index.ts` to exist, which rules out a non-directory entry the
    // same way a separate directory check would.
    for (const slug of [...entries.value].sort((left, right) => left.localeCompare(right))) {
      if (validateFunctionSlugMessage(slug) !== undefined) {
        continue;
      }
      if (yield* isFile(fs, defaultFunctionEntrypoint(functionsDir, slug))) {
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
    const fs = yield* FileSystem.FileSystem;
    const functionsDir = join(input.projectRoot, SUPABASE_FUNCTIONS_DIR);
    const seenDeprecatedImportMap = new Set<string>();
    const seenFallbackImportMap = new Set<string>();
    const resolved: ResolvedDeployFunctionConfig[] = [];

    const fallbackImportMapPath = join(functionsDir, "import_map.json");
    const fallbackExists = yield* isFile(fs, fallbackImportMapPath);

    const importMapOverride = Option.match(input.importMapOverride, {
      onNone: () => "",
      onSome: (pathname) => resolve(input.cwd, pathname),
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

      const defaultEntrypoint = defaultFunctionEntrypoint(functionsDir, slug);
      const entrypoint =
        configured.entrypoint === undefined || configured.entrypoint.length === 0
          ? defaultEntrypoint
          : resolve(
              configured.entrypoint.startsWith(".") || !isAbsolute(configured.entrypoint)
                ? join(input.supabaseDir, configured.entrypoint)
                : configured.entrypoint,
            );

      let importMap = importMapOverride;
      if (importMap.length === 0) {
        let configuredImportMap = "";
        if (configured.import_map.length > 0) {
          configuredImportMap = resolve(
            configured.import_map.startsWith(".") || !isAbsolute(configured.import_map)
              ? join(input.supabaseDir, configured.import_map)
              : configured.import_map,
          );
        }

        if (
          configuredImportMap.length > 0 &&
          !(
            (override === undefined || override.import_map.length === 0) &&
            entrypoint !== defaultEntrypoint &&
            configuredImportMap === defaultFunctionImportMap(functionsDir, slug)
          )
        ) {
          importMap = configuredImportMap;
        } else {
          const functionDir = dirname(entrypoint);
          const denoJson = join(functionDir, "deno.json");
          const denoJsonc = join(functionDir, "deno.jsonc");
          const deprecatedImportMap = join(functionDir, "import_map.json");

          if (yield* isFile(fs, denoJson)) {
            importMap = denoJson;
          } else if (yield* isFile(fs, denoJsonc)) {
            importMap = denoJsonc;
          } else if (yield* isFile(fs, deprecatedImportMap)) {
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
        isAbsolute(pathname) ? pathname : join(input.supabaseDir, pathname),
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
      createSourceMetadata(projectRoot, config, remoteBySlug.get(config.slug)),
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
            createSourceMetadata(projectRoot, config, remoteBySlug.get(config.slug)),
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
      message: cobraMutuallyExclusiveErrorMessage(FUNCTIONS_BUNDLER_MUTEX_GROUP, changedModes),
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
    return yield* new FunctionDeployJobsRequiresApiError({
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
    goConfigCompat: dependencies.goConfigCompat,
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
    search: dependencies.goConfigCompat === undefined,
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
    Effect.catchIf(Schema.is(NoFunctionsToDeployError), (error) =>
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
        // `SUPABASE_NETWORK_ID` (env or project dotenv) is CLI-only, `undefined` for library
        // callers.
        const networkMode = resolveDockerNetworkMode({
          explicit: lastExplicitLongFlagValue(dependencies.rawArgs, [], "network-id"),
          envOverride:
            context.projectEnvValues === undefined
              ? undefined
              : viperEnvStringWithProjectFallback("SUPABASE_NETWORK_ID", context.projectEnvValues),
          projectId: context.projectId,
        });
        yield* deployViaDocker({
          projectId: context.projectId,
          projectRef,
          edgeRuntimeVersion,
          functionsDir: join(dependencies.projectRoot, SUPABASE_FUNCTIONS_DIR),
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
