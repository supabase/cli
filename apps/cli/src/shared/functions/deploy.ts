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
  FileSystem,
  Predicate,
  Option,
  Path,
  Schema,
} from "effect";
import * as PlatformError from "effect/PlatformError";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { promptYesNo } from "../../command-internal/prompt-yes-no.ts";
import { bitbucketCloneDir } from "../../command-internal/bitbucket-pipeline.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../output/errors.ts";
import { Output } from "../output/output.service.ts";
import { bold } from "../../command-internal/colors.ts";
import { viperEnvStringWithProjectFallback } from "../../command-internal/viper-env.ts";
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
import {
  ConflictingFunctionDeployFlagsError,
  FunctionDeployCancelledError,
  FunctionDeployError,
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
  resolveDockerNetworkMode,
  resolveEdgeRuntimeVersion,
  resolveFunctionsDockerImage,
  runChildProcess,
  toDockerPath,
  toSlash,
} from "./functions-docker.ts";
import { loadFunctionsCliConfig, type FunctionsGoConfigCompat } from "./functions-config.ts";
import { FunctionsApiStatusError, FunctionsApiTransportError } from "./functions-api.errors.ts";
import { FunctionFilesError, planFunctionFiles } from "@supabase/stack/internal/functions/files";

const mapFunctionDeployError = <A, E, R>(
  message: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, FunctionDeployError, R> =>
  effect.pipe(Effect.mapError((cause) => new FunctionDeployError({ message, cause })));
const JsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(JsonString);
const encodeJson = Schema.encodeSync(JsonString);

const COMPRESSED_ESZIP_MAGIC = "EZBR";
const DEPLOY_RATE_LIMIT_MAX_RETRIES = 8;
const SUPABASE_FUNCTIONS_DIR = "supabase/functions";
const IMPORT_MAP_GUIDE_URL = "https://supabase.com/docs/guides/functions/import-maps";

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
    return encodeJson(decodeJson(text));
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
  const name = pathname.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
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
  url.pathname = toDockerPath(hostPath).replaceAll("%", "%25");
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

const resolveFunctionsSourceRoot = Effect.fnUntraced(function* (projectRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(projectRoot);
  for (;;) {
    const hasGitMarker = yield* fs.stat(path.join(current, ".git")).pipe(
      Effect.as(true),
      Effect.catchTag("PlatformError", (error) =>
        Predicate.isTagged(error.reason, "NotFound") ? Effect.succeed(false) : Effect.fail(error),
      ),
    );
    if (hasGitMarker) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(projectRoot);
    current = parent;
  }
});

const isNotSymbolicLink = (error: PlatformError.PlatformError): boolean => {
  if (!Predicate.isTagged(error.reason, "Unknown")) return false;
  const cause = error.reason.cause;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EINVAL";
};

function defaultFunctionEntrypoint(path: Path.Path, functionsDir: string, slug: string) {
  return path.join(functionsDir, slug, "index.ts");
}

function defaultFunctionImportMap(path: Path.Path, functionsDir: string, slug: string) {
  return path.join(functionsDir, slug, "deno.json");
}

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

const listPathsRecursive = (
  root: string,
): Effect.Effect<
  ReadonlyArray<string>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolvedRoot = path.resolve(root);
    const entries = yield* fs.readDirectory(resolvedRoot);
    const paths: string[] = [];
    for (const name of entries) {
      const pathname = path.join(resolvedRoot, name);
      paths.push(pathname);
      const isSymbolicLink = yield* fs.readLink(pathname).pipe(
        Effect.as(true),
        Effect.catchTag("PlatformError", (error) =>
          isNotSymbolicLink(error) ? Effect.succeed(false) : Effect.fail(error),
        ),
      );
      if (!isSymbolicLink && (yield* fs.stat(pathname)).type === "Directory")
        paths.push(...(yield* listPathsRecursive(pathname)));
    }
    return paths;
  });

const isFile = Effect.fnUntraced(function* (pathname: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(pathname).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.catchTag("PlatformError", (error) =>
      Predicate.isTagged(error.reason, "NotFound") ? Effect.succeed(false) : Effect.fail(error),
    ),
  );
});

const writeSourceDeployForm = Effect.fnUntraced(function* (
  sourceRoot: string,
  workdir: string,
  config: ResolvedDeployFunctionConfig,
  metadata: SourceDeployMetadata,
  outputRaw: (text: string) => Effect.Effect<void, never>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const form = new FormData();
  form.append("metadata", encodeJson(metadata));
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
      return yield* new FunctionFilesError({
        message: `failed to read file: open ${relativePath}: invalid argument`,
        reason: "filesystem",
        pathname: relativePath,
      });
    }
    yield* outputRaw(`Uploading asset (${config.slug}): ${relativePath}\n`);
    form.append("file", new File([contents], relativePath));
  });

  const plan = yield* planFunctionFiles({
    projectRoot: workdir,
    sourceRoot,
    entrypoint: config.entrypoint,
    importMap: config.importMap,
    staticFiles: config.staticFiles,
  }).pipe(
    Effect.mapError((error) =>
      error instanceof FunctionFilesError && error.reason === "import-not-directory"
        ? new FunctionImportNotDirectoryError({ message: error.message })
        : error,
    ),
  );

  for (const warning of plan.warnings) {
    if (warning.startsWith("WARN: Mounting import map scope target outside the project root:")) {
      continue;
    }
    yield* outputRaw(warning);
  }

  for (const file of plan.files) {
    if (file.externalScope) {
      yield* outputRaw(`WARN: Skipping import path outside source root: ${file.hostPath}\n`);
      continue;
    }
    const fileInfo = yield* fs.stat(file.hostPath);
    if (fileInfo.type !== "Directory") {
      yield* appendAsset(file.targetPath, yield* fs.readFile(file.hostPath), file.hostPath);
      continue;
    }
    for (const nestedPath of yield* listPathsRecursive(file.hostPath)) {
      const nestedInfo = yield* fs.stat(nestedPath);
      if (nestedInfo.type === "Directory") continue;
      const nestedRealPath = yield* fs.realPath(nestedPath);
      if (!plan.allowedRoots.some((root) => isContainedPath(path, root, nestedRealPath))) {
        yield* outputRaw(`WARN: Skipping import path outside source root: ${nestedPath}\n`);
        continue;
      }
      const nestedRelativePath = path.relative(file.hostPath, nestedPath);
      const targetPath = path.join(file.targetPath, nestedRelativePath);
      yield* appendAsset(targetPath, yield* fs.readFile(nestedPath), nestedRealPath);
    }
  }

  return form;
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

export const buildDockerBinds = Effect.fnUntraced(function* (
  projectId: string,
  functionsDir: string,
  outputDir: string,
  config: ResolvedDeployFunctionConfig,
  options: {
    readonly additionalModuleRoots?: ReadonlyArray<string>;
    readonly onWarning?: (message: string) => Effect.Effect<void, never>;
    readonly skipMissingImportMapTargets?: boolean;
    /** Resolved marker presence, including an explicitly empty project value. */
    readonly bitbucketCloneDirDefined?: boolean;
  } = {},
) {
  const path = yield* Path.Path;
  const hostFunctionsDir = path.resolve(functionsDir);
  const hostOutputDir = path.resolve(outputDir);
  const projectRoot = path.resolve(functionsDir, "..", "..");
  const sourceRoot = yield* resolveFunctionsSourceRoot(projectRoot);
  const binds: DockerBind[] = [
    {
      hostPath: hostFunctionsDir,
      containerPath: toDockerPath(hostFunctionsDir),
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
      containerPath: toDockerPath(hostOutputDir),
      mode: "rw",
      externalScope: false,
    });
  }

  const plan = yield* planFunctionFiles({
    projectRoot,
    sourceRoot,
    entrypoint: config.entrypoint,
    importMap: config.importMap,
    staticFiles: config.staticFiles,
    additionalModuleRoots: options.additionalModuleRoots,
    skipMissingImportMapTargets: options.skipMissingImportMapTargets,
  }).pipe(
    Effect.mapError((error) =>
      error instanceof FunctionFilesError && error.reason === "import-not-directory"
        ? new FunctionImportNotDirectoryError({ message: error.message })
        : error,
    ),
  );
  const warn = options.onWarning ?? (() => Effect.void);
  const extraBinds = plan.files.map<DockerBind>((file) => ({
    hostPath: file.hostPath,
    containerPath: toDockerPath(file.externalScope ? file.targetPath : file.hostPath),
    mode: "ro",
    externalScope: file.externalScope,
  }));
  const sanitizedExtraBinds = sanitizeDockerBinds(
    path,
    extraBinds,
    hostFunctionsDir,
    hostOutputDir,
  );
  const occupiedContainerPaths = new Set(binds.map((bind) => bind.containerPath));
  const uniqueExtraBinds = sanitizedExtraBinds.filter((bind) => {
    if (occupiedContainerPaths.has(bind.containerPath)) return false;
    occupiedContainerPaths.add(bind.containerPath);
    return true;
  });
  const retainedExternalHosts = new Set(
    uniqueExtraBinds.filter((bind) => bind.externalScope).map((bind) => bind.hostPath),
  );
  for (const warning of plan.warnings) {
    if (
      warning.startsWith("WARN: Mounting import map scope target outside the project root:") &&
      ![...retainedExternalHosts].some((hostPath) => warning.includes(hostPath))
    ) {
      continue;
    }
    yield* warn(warning);
  }
  return [...binds, ...uniqueExtraBinds];
});

function shouldUseDenoJsonDiscovery(path: Path.Path, entrypoint: string, importMap: string) {
  return isDenoConfigFile(importMap) && path.dirname(importMap) === path.dirname(entrypoint);
}

const shouldUsePackageJsonDiscovery = Effect.fnUntraced(function* (
  path: Path.Path,
  entrypoint: string,
  importMap: string,
) {
  if (importMap.length > 0) {
    return false;
  }
  return yield* isFile(path.join(path.dirname(entrypoint), "package.json"));
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

const bundleFunctionWithDocker = Effect.fnUntraced(function* (
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
  yield* output.raw(`Bundling Function: ${styleEmphasis(config.slug)}\n`, "stderr");

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outputRoot = path.resolve(functionsDir, "..", ".temp");
  yield* fs.makeDirectory(outputRoot, { recursive: true });
  const outputDir = yield* fs.makeTempDirectory({
    directory: outputRoot,
    prefix: `.supabase-output-${config.slug}-`,
  });
  try {
    // Go passes 0777 to MkdirAll, which Windows ignores. Calling chmod separately
    // adds an NTFS WRITE_ATTRIBUTES requirement that the Go CLI does not have.
    if (shouldChmodBundleOutputDirectory(process.platform)) {
      yield* fs.chmod(outputDir, 0o777);
    }
    const outputPath = path.join(outputDir, "output.eszip");
    // `edgeRuntimeImage` applies the tag verbatim — a `.temp/edge-runtime-version` pin flows
    // through unmodified, `v` prefix or not (see the helper's doc in `functions.shared.ts`).
    const rawImage = edgeRuntimeImage(edgeRuntimeVersion);
    const binds = yield* buildDockerBinds(projectId, functionsDir, outputDir, config, {
      bitbucketCloneDirDefined,
      onWarning: (message) => output.raw(message, "stderr"),
    });
    // Resolved per function rather than hoisted out of the loop (unlike `download.ts`'s
    // `PulledEdgeRuntimeImage`): the first resolve failure aborts the loop, and the only added
    // cost is one cached `docker image inspect` per function.
    const image = yield* mapFunctionDeployError(
      "failed to resolve Docker image",
      resolveFunctionsDockerImage(rawImage, projectEnvValues),
    );
    yield* mapFunctionDeployError(
      "failed to prepare Docker network",
      ensureDockerNetwork(networkMode, projectId),
    );
    yield* mapFunctionDeployError(
      "failed to prepare Edge Runtime volume",
      ensureDockerNamedVolume(edgeRuntimeCacheVolume(projectId).name, projectId, projectEnvValues),
    );

    const env: Array<string> = [];
    if (!(yield* shouldUsePackageJsonDiscovery(path, config.entrypoint, config.importMap))) {
      env.push("DENO_NO_PACKAGE_JSON=1");
    }
    env.push(...dockerNpmEnv());

    const containerArgs = [
      "bundle",
      "--entrypoint",
      toDockerPath(config.entrypoint),
      "--output",
      toDockerPath(outputPath),
    ];
    if (
      config.importMap.length > 0 &&
      !shouldUseDenoJsonDiscovery(path, config.entrypoint, config.importMap)
    ) {
      containerArgs.push("--import-map", toDockerPath(config.importMap));
    }
    for (const staticFile of config.staticFiles) {
      containerArgs.push("--static", toDockerPath(staticFile));
    }
    const debug = yield* Config.string("DEBUG").pipe(Config.withDefault(""));
    if (verbose || debug === "true") {
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
      workingDir: toDockerPath(path.resolve(functionsDir, "..", "..")),
      containerArgs,
    });

    // Live-tees each chunk to `output.raw` as it arrives, rather than buffering the whole run
    // until exit.
    const result = yield* mapFunctionDeployError(
      "failed to run Docker bundler",
      runChildProcess("docker", command, {
        stdout: "pipe",
        stderr: "pipe",
        onStdout: (chunk) => output.raw(chunk, output.format === "text" ? "stdout" : "stderr"),
        onStderr: (chunk) => output.raw(chunk, "stderr"),
      }),
    );
    if (result.exitCode !== 0) {
      return yield* new FunctionDeployError({
        message: `failed to bundle function: exit ${result.exitCode}`,
      });
    }

    const eszip = yield* fs.readFile(outputPath);
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
    const sha256 = yield* Effect.tryPromise(() => crypto.subtle.digest("SHA-256", compressed));
    const hash = Buffer.from(sha256).toString("hex");
    return {
      slug: config.slug,
      metadata: createBundledMetadata(config, hash),
      body: compressed,
    } satisfies BundledFunction;
  } finally {
    yield* fs.remove(outputDir, { recursive: true, force: true }).pipe(Effect.ignore);
  }
});

const listRemoteFunctions = Effect.fnUntraced(function* (api: ApiClient, projectRef: string) {
  let lastError:
    | FunctionDeployError
    | FunctionsApiStatusError
    | FunctionsApiTransportError
    | SupabaseApiInputError
    | HttpBody.HttpBodyError
    | undefined;
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
        return yield* Effect.try({
          try: () => decodeFunctionListResponse(decodeJson(body)),
          catch: (error) =>
            new FunctionsApiStatusError({
              status: result.response.status,
              message: `failed to read functions list: ${error instanceof Error ? error.message : String(error)}`,
              decode: true,
            }),
        });
      }
      lastError = new FunctionsApiStatusError({
        status: result.response.status,
        message: `unexpected list functions status ${result.response.status}: ${body}`,
      });
      if (result.response.status < 500 && result.response.status !== 429) {
        return yield* Effect.failCause(Cause.fail(lastError));
      }
    } else {
      lastError = mapTransportError("failed to list functions", result.error);
    }

    if (attempt < 3) {
      yield* Effect.sleep(Duration.millis(1_000 * 2 ** attempt));
    }
  }
  if (lastError !== undefined) return yield* Effect.failCause(Cause.fail(lastError));
  return yield* new FunctionDeployError({ message: "failed to list functions" });
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

const uploadFunctionSource = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  sourceRoot: string,
  workdir: string,
  config: ResolvedDeployFunctionConfig,
  metadata: SourceDeployMetadata,
  bundleOnly: boolean,
) {
  const output = yield* Output;
  const form = yield* writeSourceDeployForm(sourceRoot, workdir, config, metadata, (text) =>
    output.raw(text, "stderr"),
  );
  const files = form.getAll("file").flatMap((part) => (part instanceof Blob ? [part] : []));
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
    try: () => decodeDeployFunctionResponse(decodeJson(body)),
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

const bulkUpdateRemoteFunctions = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  functions: ReadonlyArray<BulkUpdateFunction>,
) {
  let lastError:
    | FunctionDeployError
    | FunctionsApiStatusError
    | FunctionsApiTransportError
    | SupabaseApiInputError
    | HttpBody.HttpBodyError
    | undefined;
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
        return yield* Effect.failCause(Cause.fail(lastError));
      }
    } else {
      lastError = mapTransportError("failed to bulk update", result.error);
    }

    if (attempt < 3) {
      yield* Effect.sleep(Duration.millis(1_000 * 2 ** attempt));
    }
  }
  if (lastError !== undefined) return yield* Effect.failCause(Cause.fail(lastError));
  return yield* new FunctionDeployError({ message: "failed to bulk update" });
});

const upsertBundledFunction = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  bundled: BundledFunction,
  exists: boolean,
) {
  let shouldUpdate = exists;
  let lastError:
    | FunctionDeployError
    | FunctionsApiStatusError
    | FunctionsApiTransportError
    | SupabaseApiInputError
    | HttpBody.HttpBodyError
    | undefined;

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
        return yield* Effect.try({
          try: () => decodeDeployFunctionResponse(decodeJson(body)),
          catch: (error) =>
            new FunctionsApiStatusError({
              status: response.value.status,
              message: `failed to read function response: ${error instanceof Error ? error.message : String(error)}`,
              decode: true,
            }),
        });
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
      lastError = mapTransportError("failed to upsert function", response.error);
    }

    if (attempt < 3) {
      yield* Effect.sleep(Duration.millis(500 * 2 ** attempt));
    }
  }

  if (lastError !== undefined) return yield* Effect.failCause(Cause.fail(lastError));
  return yield* new FunctionDeployError({ message: "failed to upsert function" });
});

const deleteRemoteFunction = Effect.fnUntraced(function* (
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

export const discoverFunctionSlugs = Effect.fnUntraced(function* (
  projectRoot: string,
  configDeclaredFunctions: Readonly<Record<string, ManifestFunctionConfig>>,
) {
  const path = yield* Path.Path;
  const functionsDir = path.join(projectRoot, SUPABASE_FUNCTIONS_DIR);
  const fs = yield* FileSystem.FileSystem;
  const slugs: string[] = [];

  const entries = yield* fs
    .readDirectory(functionsDir)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        Predicate.isTagged(error.reason, "NotFound") ? Effect.void : Effect.fail(error),
      ),
    );
  if (entries !== undefined) {
    for (const slug of entries.sort((left, right) => left.localeCompare(right))) {
      const pathname = path.join(functionsDir, slug);
      const isSymbolicLink = yield* fs.readLink(pathname).pipe(
        Effect.as(true),
        Effect.catchTag("PlatformError", (error) =>
          isNotSymbolicLink(error) ? Effect.succeed(false) : Effect.fail(error),
        ),
      );
      if (!isSymbolicLink && (yield* fs.stat(pathname)).type !== "Directory") {
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

export const resolveFunctionConfigs = Effect.fnUntraced(function* (input: {
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
        hasOwnKey(input.rawConfigFunctions[slug], "verify_jwt") ? configured.verify_jwt : undefined,
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
});

const deployViaApi = Effect.fnUntraced(function* (
  projectRef: string,
  projectRoot: string,
  configs: ReadonlyArray<ResolvedDeployFunctionConfig>,
  api: ApiClient,
  jobs: number,
) {
  const output = yield* Output;
  const path = yield* Path.Path;
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

const deployViaDocker = Effect.fnUntraced(function* (options: DeployViaDockerOptions) {
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
    }).pipe(
      Effect.mapError(
        (cause) => new FunctionDeployError({ message: "failed to bundle function", cause }),
      ),
    );
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

const pruneFunctions = Effect.fnUntraced(function* (
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
