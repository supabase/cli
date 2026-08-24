import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { URL } from "node:url";
import {
  FunctionResponse,
  operationDefinitions,
  SupabaseApiInputError,
  type ApiClient,
} from "@supabase/api/effect";
import {
  inferFunctionsManifest,
  type ResolvedFunctionConfig as ManifestFunctionConfig,
} from "@supabase/config";
import { Duration, Effect, Option, Schema } from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { legacyPromptYesNo } from "../legacy/legacy-prompt-yes-no.ts";
import { CONTEXT_CANCELED_MESSAGE } from "../output/errors.ts";
import { Output } from "../output/output.service.ts";
import { legacyBold } from "../../legacy/shared/legacy-colors.ts";
import { legacyViperEnvStringWithProjectFallback } from "../legacy/legacy-viper-env.ts";
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
import {
  ConflictingFunctionDeployFlagsError,
  FunctionDeployCancelledError,
  FunctionImportNotDirectoryError,
  InvalidFunctionDeploySlugError,
  NoFunctionsToDeployError,
} from "./deploy.errors.ts";
import {
  buildFunctionsDockerRunArgs,
  ensureDockerNamedVolume,
  ensureDockerNetwork,
  isDockerRunning,
  localDockerId,
  resolveDockerNetworkMode,
  resolveEdgeRuntimeVersion,
  resolveFunctionsDockerImage,
  runChildProcess,
  toDockerPath,
  toSlash,
} from "./functions-docker.ts";
import { loadFunctionsProjectConfig, type FunctionsGoConfigCompat } from "./functions-config.ts";
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
   * `undefined` in `next`; the legacy shell injects
   * `legacyFunctionsGoConfigCompat` so this file never imports `legacy/`
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
   * Optional shell-specific styling hooks. Both default to identity (plain
   * text); the legacy shell injects Go's aqua/bold here so the next shell
   * stays isolated from `legacy/`-specific rendering.
   * - `styleIdentifier`: the project ref in the stdout success line.
   * - `styleEmphasis`: the slug in the stderr `Bundling Function:` line and
   *   the functions dir in the no-functions error.
   * - `styleWarning`: the `WARNING:` token on the "Docker is not running"
   *   fallback line. Go: `utils.Yellow("WARNING:")` (`deploy.go:60`).
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

type RemoteFunction = typeof FunctionResponse.Type;
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

const decodeFunctionListResponseSchema = Schema.decodeUnknownSync(Schema.Array(FunctionResponse));
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

// Format a raw response body for an unexpected-status error message. When the
// body is JSON, re-stringify it so the message stays byte-identical to the
// previous `JSON.stringify(parsedBody)` form; otherwise fall back to the raw
// text (a non-JSON body was previously impossible because the response was
// eagerly JSON-decoded before the status check).
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
 * Must stay in sync with `LEGACY_CLI_WORKDIR_LABEL`
 * (`legacy/shared/legacy-docker-ids.ts:95`) — same string literal, kept as a
 * separate copy here rather than imported to respect the `next`/`legacy`
 * isolation boundary (this file has no Go equivalent for the other two
 * labels either). Read back by `legacyCleanupStartSecrets` so a later
 * `stop`/`legacyRollbackStart` can reclaim this container's staged-secret
 * directory using its OWN workdir rather than the caller's cwd.
 */
export const dockerWorkdirLabel = "com.supabase.cli.workdir";
/**
 * Go parity (`apps/cli-go/internal/functions/deploy/bundle.go:68-70`, deleted
 * in CLI-1970; last present at commit 7b469f5b3): the eszip
 * bundler container receives only `NPM_CONFIG_REGISTRY` from the host
 * environment. `NPM_AUTH_TOKEN` is deliberately NOT forwarded — the Go-side PR
 * proposing it (supabase/cli#4933) was closed unmerged, and CLI-1985 ruled
 * strict parity over the TS-only forwarding that #5645 had added.
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

function isContainedPath(root: string, candidate: string) {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
  );
}

function isContainedInAnyPath(roots: ReadonlyArray<string>, candidate: string) {
  return roots.some((root) => isContainedPath(root, candidate));
}

/**
 * Go parity (`apps/cli-go/pkg/function/deploy.go:251-284`, via
 * `afero.IOFS.Open` → `fs.ValidPath`): `writeForm`'s `addFile` opens every
 * uploaded path through an `fs.FS`, which rejects any path containing a `..`
 * element before the read (and thus the upload) happens. A workdir≠git-root
 * layout can otherwise produce a multipart `File` name like
 * `../packages/shared/src/index.ts` that escapes the anchor dir — reject it
 * the same way Go does, before any upload is attempted.
 */
function hasParentPathSegment(relativePath: string) {
  return toSlash(relativePath)
    .split("/")
    .some((segment) => segment === "..");
}

async function realpathIfExists(pathname: string) {
  try {
    return await realpath(resolve(pathname));
  } catch (error) {
    // ENOTDIR (a path routed through a file) is as nonexistent as ENOENT here.
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return resolve(pathname);
    }
    throw error;
  }
}

async function resolveFunctionsSourceRoot(projectRoot: string) {
  return (await findGitRootPath(projectRoot)) ?? resolve(projectRoot);
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

function readStringMap(input: unknown, fieldName: string): Record<string, string> {
  if (input === undefined) {
    return {};
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`failed to parse import map: expected ${fieldName} to be an object`);
  }

  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") {
      throw new Error(`failed to parse import map: expected ${fieldName}.${key} to be a string`);
    }
    values[key] = value;
  }
  return values;
}

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

  static fromUnknown(input: unknown) {
    const imports: Record<string, string> = {};
    const scopes: Record<string, Record<string, string>> = {};
    let importMapReference = "";

    if (typeof input === "object" && input !== null) {
      const importMap = getObjectProperty(input, "importMap");
      if (typeof importMap === "string") {
        importMapReference = importMap;
      }

      Object.assign(imports, readStringMap(getObjectProperty(input, "imports"), "imports"));

      const rawScopes = getObjectProperty(input, "scopes");
      if (rawScopes === undefined) {
        return new ImportMapFile(imports, scopes, importMapReference);
      }
      if (typeof rawScopes !== "object" || rawScopes === null || Array.isArray(rawScopes)) {
        throw new Error("failed to parse import map: expected scopes to be an object");
      }
      for (const [scopeName, scopeValue] of Object.entries(rawScopes)) {
        scopes[scopeName] = readStringMap(scopeValue, `scopes.${scopeName}`);
      }
    }

    return new ImportMapFile(imports, scopes, importMapReference);
  }

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

async function loadImportMapFile(
  pathname: string,
  onRead?: (pathname: string, contents: Uint8Array) => Promise<void>,
  seen = new Set<string>(),
): Promise<ImportMapFile> {
  const resolvedPath = resolve(pathname);
  if (seen.has(resolvedPath)) {
    throw new Error(`cyclic import map reference: ${pathname}`);
  }
  seen.add(resolvedPath);
  const contents = await readFile(pathname);
  if (onRead !== undefined) {
    await onRead(pathname, contents);
  }
  const parsed = JSON.parse(stripJsonComments(new TextDecoder().decode(contents)));
  const importMap = ImportMapFile.fromUnknown(parsed).resolve(toSlash(pathname));
  if (isDenoConfigFile(pathname) && importMap.isReference()) {
    const nestedPath = join(dirname(pathname), importMap.importMapReference);
    return loadImportMapFile(nestedPath, onRead, seen);
  }
  return importMap;
}

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
    // Import-maps spec (implemented by Deno): a key matches exactly, or as a
    // prefix only when it ends with "/". Go's walker prefix-matches every key
    // (pkg/function/deno.go:150-155) — intentional divergence, see
    // go-cli-divergences.md: the lax match fabricates paths the runtime
    // can never resolve (the ENOTDIR family this PR fixes).
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

async function walkImportPaths(
  importMap: ImportMapFile,
  srcPath: string,
  allowedRoots: ReadonlyArray<string>,
  displayRoot: string,
  onFile: (pathname: string, contents: Uint8Array) => Promise<void>,
  onWarning: (message: string) => Promise<void>,
) {
  const seen = new Set<string>();
  const queue = [toSlash(srcPath)];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);

    let contents: Uint8Array;
    try {
      const resolvedCurrent = await realpath(resolve(current));
      if (!isContainedInAnyPath(allowedRoots, resolvedCurrent)) {
        await onWarning(`WARN: Skipping import path outside source root: ${current}\n`);
        continue;
      }
      contents = await readFile(resolvedCurrent);
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        if (error.code === "ENOENT") {
          const message = `failed to read file: open ${toApiRelativePath(displayRoot, current)}: no such file or directory`;
          await onWarning(`WARN: ${message}\n`);
          continue;
        }
        // Go aborts on any other read error (pkg/function/deno.go:131-136); an
        // ENOTDIR (import path routed through a file) gets Go's message instead
        // of an unhandled raw Node error, via a classified error so telemetry
        // books it as user-fixable config instead of a panic.
        if (error.code === "ENOTDIR") {
          throw new FunctionImportNotDirectoryError({
            message: `failed to read file: open ${toApiRelativePath(displayRoot, current)}: not a directory`,
          });
        }
      }
      throw error;
    }

    await onFile(current, contents);
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

      // A module file needs a dot in the FINAL path segment (Go's path.Ext
      // semantics): a dot earlier in the path (`dist/index.mjs/core`) is a
      // directory-shaped path, not a module file. Not basename(): a
      // trailing-slash directory import must yield an empty final segment here.
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
      const containmentPath = await realpathIfExists(resolvedModule);
      if (!isContainedInAnyPath(allowedRoots, containmentPath)) {
        await onWarning(`WARN: Skipping import path outside source root: ${modulePath}\n`);
        continue;
      }
      queue.push(toSlash(resolvedModule));
    }
  }
}

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

async function listPathsRecursive(root: string): Promise<ReadonlyArray<string>> {
  const resolvedRoot = resolve(root);
  const entries = await readdir(resolvedRoot, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const pathname = join(resolvedRoot, entry.name);
    paths.push(pathname);
    if (entry.isDirectory()) {
      paths.push(...(await listPathsRecursive(pathname)));
    }
  }
  return paths;
}

async function expandStaticPattern(pattern: string): Promise<ReadonlyArray<string>> {
  if (!hasGlobMeta(pattern)) {
    try {
      await stat(pattern);
    } catch {
      throw new Error(`no files matched pattern: ${pattern}`);
    }
    return [pattern];
  }

  const baseDir = globBaseDirectory(pattern);
  const matcher = globToRegExp(toSlash(resolve(pattern)));
  let candidates: ReadonlyArray<string>;
  try {
    candidates = await listPathsRecursive(baseDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`no files matched pattern: ${pattern}`);
    }
    throw error;
  }
  const matches = candidates.filter((candidate) => matcher.test(toSlash(resolve(candidate))));
  if (matches.length === 0) {
    throw new Error(`no files matched pattern: ${pattern}`);
  }
  return matches;
}

async function forEachLocalImportMapTarget(
  importMap: ImportMapFile,
  onTarget: (pathname: string, kind: "import" | "scope") => Promise<void>,
) {
  for (const target of Object.values(importMap.imports)) {
    if (isRemoteImportTarget(target)) {
      continue;
    }
    await onTarget(target, "import");
  }
  for (const scope of Object.values(importMap.scopes)) {
    for (const target of Object.values(scope)) {
      if (isRemoteImportTarget(target)) {
        continue;
      }
      await onTarget(target, "scope");
    }
  }
}

async function walkLocalImportMapTargetImports(
  importMap: ImportMapFile,
  pathname: string,
  allowedRoots: ReadonlyArray<string>,
  displayRoot: string,
  onFile: (pathname: string, contents: Uint8Array) => Promise<void>,
  onWarning: (message: string) => Promise<void>,
) {
  if ((await stat(pathname)).isDirectory()) {
    return;
  }
  await walkImportPaths(importMap, pathname, allowedRoots, displayRoot, onFile, onWarning);
}

async function isFile(pathname: string): Promise<boolean> {
  try {
    return (await stat(pathname)).isFile();
  } catch {
    return false;
  }
}

async function resolveImportMapAllowedRoots(projectRoot: string, importMapPath: string) {
  const realProjectRoot = await realpath(projectRoot);
  const allowedRoots = [realProjectRoot];
  if (importMapPath.length === 0) {
    return allowedRoots;
  }

  const realImportMapPath = await realpath(importMapPath);
  if (!isContainedPath(realProjectRoot, realImportMapPath)) {
    allowedRoots.push(dirname(realImportMapPath));
  }
  if (isDenoConfigFile(importMapPath)) {
    const contents = await readFile(importMapPath);
    const parsed = JSON.parse(stripJsonComments(new TextDecoder().decode(contents)));
    const importMap = ImportMapFile.fromUnknown(parsed);
    if (importMap.importMapReference.length > 0) {
      const referencedImportMapPath = await realpath(
        join(dirname(importMapPath), importMap.importMapReference),
      );
      if (!isContainedPath(realProjectRoot, referencedImportMapPath)) {
        allowedRoots.push(dirname(referencedImportMapPath));
      }
    }
  }
  return allowedRoots;
}

async function writeSourceDeployForm(
  sourceRoot: string,
  workdir: string,
  config: ResolvedDeployFunctionConfig,
  metadata: SourceDeployMetadata,
  outputRaw: (text: string) => Effect.Effect<void, never>,
) {
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  const realSourceRoot = await realpath(sourceRoot);
  const importMapAllowedRoots = await resolveImportMapAllowedRoots(sourceRoot, config.importMap);
  const uploadedAssets = new Set<string>();

  const appendAsset = async (pathname: string, contents: Uint8Array, realPathname: string) => {
    if (uploadedAssets.has(realPathname)) {
      return;
    }
    uploadedAssets.add(realPathname);
    // Uploaded file names are anchored at the workdir like Go's `toRelPath`
    // (`apps/cli-go/pkg/function/deploy.go:94-103`, relative to `os.Getwd()`),
    // NOT at `sourceRoot` — see the CLI-1985 note in `deployViaApi`.
    const relativePath = toApiRelativePath(workdir, pathname);
    if (hasParentPathSegment(relativePath)) {
      throw new Error(`failed to read file: open ${relativePath}: invalid argument`);
    }
    await Effect.runPromise(outputRaw(`Uploading asset (${config.slug}): ${relativePath}\n`));
    form.append("file", new File([contents], relativePath));
  };

  const uploadAsset = async (pathname: string, contents: Uint8Array) => {
    const realPathname = await realpath(pathname);
    if (!isContainedPath(realSourceRoot, realPathname)) {
      throw new Error(`refusing to upload asset outside source root: ${pathname}`);
    }
    await appendAsset(pathname, contents, realPathname);
  };

  const uploadImportMapAsset = async (pathname: string, contents: Uint8Array) => {
    const realPathname = await realpath(pathname);
    if (!isContainedInAnyPath(importMapAllowedRoots, realPathname)) {
      throw new Error(`refusing to upload import map outside allowed roots: ${pathname}`);
    }
    await appendAsset(pathname, contents, realPathname);
  };

  const uploadImportMapTargetAsset = async (pathname: string, contents: Uint8Array) => {
    const realPathname = await realpath(pathname);
    if (!isContainedInAnyPath(importMapAllowedRoots, realPathname)) {
      await Effect.runPromise(
        outputRaw(`WARN: Skipping import path outside source root: ${pathname}\n`),
      );
      return;
    }
    await appendAsset(pathname, contents, realPathname);
  };

  const uploadScopeTarget = async (pathname: string) => {
    let resolvedPath: string;
    let pathInfo: Awaited<ReturnType<typeof stat>>;
    try {
      resolvedPath = await realpath(pathname);
      pathInfo = await stat(pathname);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOTDIR") {
        await Effect.runPromise(
          outputRaw(`WARN: Skipping import map target that is not a directory: ${pathname}\n`),
        );
        return;
      }
      throw error;
    }
    if (!isContainedInAnyPath(importMapAllowedRoots, resolvedPath)) {
      await Effect.runPromise(
        outputRaw(`WARN: Skipping import path outside source root: ${pathname}\n`),
      );
      return;
    }
    if (!pathInfo.isDirectory()) {
      await uploadImportMapTargetAsset(pathname, await readFile(pathname));
      await walkLocalImportMapTargetImports(
        importMap,
        pathname,
        importMapAllowedRoots,
        workdir,
        uploadImportMapTargetAsset,
        async (message) => {
          await Effect.runPromise(outputRaw(message));
        },
      );
      return;
    }
    const nestedPaths = await listPathsRecursive(pathname);
    for (const nestedPath of nestedPaths) {
      if ((await stat(nestedPath)).isDirectory()) {
        continue;
      }
      const resolvedNestedPath = await realpath(nestedPath);
      if (!isContainedInAnyPath(importMapAllowedRoots, resolvedNestedPath)) {
        await Effect.runPromise(
          outputRaw(`WARN: Skipping import path outside source root: ${nestedPath}\n`),
        );
        continue;
      }
      await uploadImportMapTargetAsset(nestedPath, await readFile(nestedPath));
    }
  };

  if (metadata.import_map_path !== undefined && metadata.import_map_path.length > 0) {
    await loadImportMapFile(config.importMap, uploadImportMapAsset);
  }

  for (const pattern of config.staticFiles) {
    let files: ReadonlyArray<string>;
    try {
      files = await expandStaticPattern(pattern);
    } catch (error) {
      await Effect.runPromise(
        outputRaw(`WARN: ${error instanceof Error ? error.message : String(error)}\n`),
      );
      continue;
    }
    for (const pathname of files) {
      if ((await stat(pathname)).isDirectory()) {
        throw new Error(`file path is a directory: ${pathname}`);
      }
      await uploadAsset(pathname, await readFile(pathname));
    }
  }

  const importMap =
    metadata.import_map_path !== undefined && metadata.import_map_path.length > 0
      ? await loadImportMapFile(config.importMap)
      : new ImportMapFile();
  await walkImportPaths(
    importMap,
    config.entrypoint,
    [realSourceRoot],
    workdir,
    uploadAsset,
    async (message) => {
      await Effect.runPromise(outputRaw(message));
    },
  );
  await forEachLocalImportMapTarget(importMap, uploadScopeTarget);

  return form;
}

/**
 * Server-recorded metadata paths are anchored at the workdir, matching Go's
 * `toRelPath` (`apps/cli-go/pkg/function/deploy.go:42-57,94-103`): relative to
 * `os.Getwd()` (the Go CLI chdirs to the workdir), forward slashes via
 * `filepath.ToSlash` — see the CLI-1985 note in `deployViaApi`.
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

export async function buildDockerBinds(
  projectId: string,
  functionsDir: string,
  outputDir: string,
  config: ResolvedDeployFunctionConfig,
  options: {
    readonly additionalModuleRoots?: ReadonlyArray<string>;
    readonly onWarning?: (message: string) => Promise<void>;
    readonly skipMissingImportMapTargets?: boolean;
  } = {},
): Promise<ReadonlyArray<DockerBind>> {
  const hostFunctionsDir = resolve(functionsDir);
  const hostOutputDir = resolve(outputDir);
  const projectRoot = resolve(functionsDir, "..", "..");
  const sourceRoot = await resolveFunctionsSourceRoot(projectRoot);
  const realSourceRoot = await realpath(sourceRoot);
  const moduleRoots = [
    realSourceRoot,
    ...(
      await Promise.all(
        (options.additionalModuleRoots ?? []).map(async (root) => {
          try {
            return await realpath(root);
          } catch {
            return undefined;
          }
        }),
      )
    ).flatMap((root) => (root === undefined ? [] : [root])),
  ];
  const importMapAllowedRoots = await resolveImportMapAllowedRoots(sourceRoot, config.importMap);
  const binds: DockerBind[] = [
    {
      hostPath: hostFunctionsDir,
      containerPath: toDockerPath(hostFunctionsDir),
      mode: "ro",
      externalScope: false,
    },
  ];
  if (process.env["BITBUCKET_CLONE_DIR"] === undefined) {
    binds.unshift({
      hostPath: localDockerId("edge_runtime", projectId),
      containerPath: "/root/.cache/deno",
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

  const warn = options.onWarning ?? (async () => {});
  const extraBinds: DockerBind[] = [];
  const explicitScopeBinds = new Map<string, DockerBind>();
  const appendBindWithinRoots = async (roots: ReadonlyArray<string>, pathname: string) => {
    const hostPath = await realpath(pathname);
    const contained = isContainedInAnyPath(roots, hostPath);
    if (contained) {
      extraBinds.push({
        hostPath,
        containerPath: toDockerPath(hostPath),
        mode: "ro",
        externalScope: false,
      });
    }
    return { hostPath, contained };
  };
  const appendProjectBind = async (pathname: string, _contents: Uint8Array) => {
    await appendBindWithinRoots([realSourceRoot], pathname);
  };
  const appendModuleBind = async (pathname: string, _contents: Uint8Array) => {
    await appendBindWithinRoots(moduleRoots, pathname);
  };
  const appendImportMapBind = async (pathname: string, _contents: Uint8Array) => {
    await appendBindWithinRoots(importMapAllowedRoots, pathname);
  };
  const importMap =
    config.importMap.length > 0
      ? await loadImportMapFile(config.importMap, appendImportMapBind)
      : new ImportMapFile();
  await walkImportPaths(
    importMap,
    config.entrypoint,
    moduleRoots,
    sourceRoot,
    appendModuleBind,
    warn,
  );
  await forEachLocalImportMapTarget(importMap, async (target, kind) => {
    try {
      const { hostPath, contained } = await appendBindWithinRoots(importMapAllowedRoots, target);
      const isDirectory = (await stat(target)).isDirectory();
      if (!contained && kind === "scope") {
        const scopeBind: DockerBind = {
          hostPath,
          containerPath: toDockerPath(target),
          mode: "ro",
          externalScope: true,
        };
        explicitScopeBinds.set(formatDockerBind(scopeBind), scopeBind);
      }
      if (isDirectory) {
        return;
      }
      await walkLocalImportMapTargetImports(
        importMap,
        target,
        importMapAllowedRoots,
        sourceRoot,
        appendImportMapBind,
        async () => {},
      );
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        // ENOTDIR (a trailing-slash value routed through a file) is never a
        // walkable target regardless of caller: an import that actually
        // reaches through that file still fails via the walker's
        // FunctionImportNotDirectoryError.
        if (error.code === "ENOTDIR") {
          await warn(`WARN: Skipping import map target that is not a directory: ${target}\n`);
          return;
        }
        if (options.skipMissingImportMapTargets === true && error.code === "ENOENT") {
          await warn(`WARN: Skipping missing import map target: ${target}\n`);
          return;
        }
      }
      throw error;
    }
  });
  for (const pattern of config.staticFiles) {
    let files: ReadonlyArray<string>;
    try {
      files = await expandStaticPattern(pattern);
    } catch {
      continue;
    }
    for (const pathname of files) {
      if ((await stat(pathname)).isDirectory()) {
        throw new Error(`file path is a directory: ${pathname}`);
      }
      await appendProjectBind(pathname, new Uint8Array());
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
    await warn(
      `WARN: Mounting import map scope target outside the project root: ${bind.hostPath}\n`,
    );
  }

  return [...binds, ...sanitizedExtraBinds, ...uniqueScopeBinds];
}

function shouldUseDenoJsonDiscovery(entrypoint: string, importMap: string) {
  return isDenoConfigFile(importMap) && dirname(importMap) === dirname(entrypoint);
}

async function shouldUsePackageJsonDiscovery(entrypoint: string, importMap: string) {
  if (importMap.length > 0) {
    return false;
  }
  try {
    await stat(join(dirname(entrypoint), "package.json"));
    return true;
  } catch {
    return false;
  }
}

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
  const output = yield* Output;
  // Go: `fmt.Fprintln(os.Stderr, "Bundling Function:", utils.Bold(slug))`
  // (`internal/functions/deploy/bundle.go:30`) — the legacy handler injects
  // the bold styling via `styleEmphasis`; next stays plain.
  yield* output.raw(`Bundling Function: ${styleEmphasis(config.slug)}\n`, "stderr");

  const outputRoot = resolve(functionsDir, "..", ".temp");
  yield* Effect.tryPromise(() => mkdir(outputRoot, { recursive: true }));
  const outputDir = yield* Effect.tryPromise(() =>
    mkdtemp(join(outputRoot, `.supabase-output-${config.slug}-`)),
  );
  try {
    // Go passes 0777 to MkdirAll, which Windows ignores. Calling chmod separately
    // adds an NTFS WRITE_ATTRIBUTES requirement that the Go CLI does not have.
    if (shouldChmodBundleOutputDirectory(process.platform)) {
      yield* Effect.tryPromise({
        try: () => chmod(outputDir, 0o777),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
    }
    const outputPath = join(outputDir, "output.eszip");
    const binds = yield* Effect.promise(() =>
      buildDockerBinds(projectId, functionsDir, outputDir, config, {
        onWarning: (message) => Effect.runPromise(output.raw(message, "stderr")),
      }),
    );
    // Go: `DockerStart` -> `DockerResolveImageIfNotCached` (`internal/utils/docker.go:326-386`)
    // — resolves ECR->GHCR->Docker-Hub candidates and pulls with retry, per
    // container, before ever touching the network/volume. Deliberately NOT
    // hoisted out of the per-function loop the way `download.ts`'s
    // `PulledEdgeRuntimeImage` is: per-slug matches Go's per-container
    // `DockerStart` exactly, and the first resolve failure aborts the loop,
    // so the only cost is one cached `docker image inspect` per function.
    const image = yield* resolveFunctionsDockerImage(
      // `edgeRuntimeImage` applies the tag VERBATIM (Go's `replaceImageTag`)
      // — a `.temp/edge-runtime-version` pin flows through unmodified, `v`
      // prefix or not (see the helper's doc in `functions.shared.ts`).
      edgeRuntimeImage(edgeRuntimeVersion),
      projectEnvValues,
    );
    yield* ensureDockerNetwork(networkMode, projectId);
    yield* ensureDockerNamedVolume(localDockerId("edge_runtime", projectId), projectId);

    const env: Array<string> = [];
    if (
      !(yield* Effect.promise(() =>
        shouldUsePackageJsonDiscovery(config.entrypoint, config.importMap),
      ))
    ) {
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
      !shouldUseDenoJsonDiscovery(config.entrypoint, config.importMap)
    ) {
      containerArgs.push("--import-map", toDockerPath(config.importMap));
    }
    for (const staticFile of config.staticFiles) {
      containerArgs.push("--static", toDockerPath(staticFile));
    }
    if (verbose || process.env["DEBUG"] === "true") {
      containerArgs.push("--verbose");
    }

    const command = buildFunctionsDockerRunArgs({
      image,
      projectId,
      networkMode,
      binds: binds.map(formatDockerBind),
      env,
      // Go: `WorkingDir: utils.ToDockerPath(cwd)` (`bundle.go:79`), where
      // `cwd` is the post-`ChangeWorkDir` workdir — `functionsDir` is
      // `<workdir>/supabase/functions`, same derivation as `deployViaApi`'s
      // own `projectRoot`.
      workingDir: toDockerPath(resolve(functionsDir, "..", "..")),
      containerArgs,
    });

    // Live-tees each chunk to `output.raw` as it arrives (Go's
    // `DockerRunOnceWithConfig` copies the container's log stream live)
    // rather than buffering the whole run until exit.
    const result = yield* runChildProcess("docker", command, {
      stdout: "pipe",
      stderr: "pipe",
      onStdout: (chunk) => output.raw(chunk, output.format === "text" ? "stdout" : "stderr"),
      onStderr: (chunk) => output.raw(chunk, "stderr"),
    });
    if (result.exitCode !== 0) {
      return yield* Effect.fail(new Error(`failed to bundle function: exit ${result.exitCode}`));
    }

    const eszip = yield* Effect.tryPromise({
      try: () => readFile(outputPath),
      catch: (error) =>
        new Error(
          `failed to open eszip: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });
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
    return {
      slug: config.slug,
      metadata: createBundledMetadata(config, hash),
      body: compressed,
    } satisfies BundledFunction;
  } finally {
    yield* Effect.tryPromise(() => rm(outputDir, { recursive: true, force: true })).pipe(
      Effect.orElseSucceed(() => undefined),
    );
  }
});

const listRemoteFunctions = Effect.fnUntraced(function* (api: ApiClient, projectRef: string) {
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
        return yield* Effect.try({
          try: () => decodeFunctionListResponse(JSON.parse(body)),
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
        return yield* Effect.fail(lastError);
      }
    } else {
      lastError = result.error;
    }

    if (attempt < 3) {
      yield* Effect.sleep(Duration.millis(1_000 * 2 ** attempt));
    }
  }
  return yield* Effect.fail(lastError ?? new Error("failed to list functions"));
});

function headerValue(headers: Readonly<Record<string, string | undefined>>, name: string) {
  return headers[name.toLowerCase()] ?? headers[name];
}

function parseRateLimitDelay(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) {
    return Math.max(seconds, 0) * 1_000;
  }
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.max(timestamp - Date.now(), 0);
  }
  return undefined;
}

function rateLimitDelayMillis(
  headers: Readonly<Record<string, string | undefined>>,
  attempt: number,
) {
  return (
    parseRateLimitDelay(headerValue(headers, "retry-after")) ??
    parseRateLimitDelay(headerValue(headers, "x-ratelimit-reset")) ??
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
    const delayMs = rateLimitDelayMillis(response.headers, attempt);
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
  const files = yield* Effect.tryPromise({
    try: async () => {
      const form = await writeSourceDeployForm(sourceRoot, workdir, config, metadata, (text) =>
        output.raw(text, "stderr"),
      );
      return form.getAll("file").flatMap((part) => (part instanceof Blob ? [part] : []));
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
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
    return yield* Effect.fail(
      new FunctionsApiStatusError({
        status: response.status,
        message: `unexpected deploy status ${response.status}: ${formatUnexpectedStatusBody(body)}`,
      }),
    );
  }
  // A 201 whose body is not the expected JSON is an API-response problem, not a
  // transport failure — surface it via FunctionsApiStatusError so it classifies
  // as api_status rather than network.
  return yield* Effect.try({
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

const bulkUpdateRemoteFunctions = Effect.fnUntraced(function* (
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
  return yield* Effect.fail(lastError ?? new Error("failed to bulk update"));
});

const upsertBundledFunction = Effect.fnUntraced(function* (
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
        return yield* Effect.try({
          try: () => decodeDeployFunctionResponse(JSON.parse(body)),
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
      lastError = response.error;
    }

    if (attempt < 3) {
      yield* Effect.sleep(Duration.millis(500 * 2 ** attempt));
    }
  }

  return yield* Effect.fail(lastError ?? new Error("failed to upsert function"));
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
  return yield* Effect.fail(
    new FunctionsApiStatusError({
      status: response.status,
      message: `unexpected delete function status ${response.status}: ${body}`,
    }),
  );
});

export const discoverFunctionSlugs = Effect.fnUntraced(function* (
  projectRoot: string,
  configDeclaredFunctions: Readonly<Record<string, ManifestFunctionConfig>>,
) {
  const functionsDir = join(projectRoot, SUPABASE_FUNCTIONS_DIR);
  const slugs: string[] = [];

  const entries = yield* Effect.tryPromise({
    try: () => readdir(functionsDir, { withFileTypes: true }),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.catch((error) => {
      return "code" in error && error.code === "ENOENT"
        ? Effect.succeed(undefined)
        : Effect.fail(error);
    }),
  );
  if (entries !== undefined) {
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      const slug = entry.name;
      if (validateFunctionSlugMessage(slug) !== undefined) {
        continue;
      }
      const hasDefaultEntrypoint = yield* Effect.promise(() =>
        isFile(defaultFunctionEntrypoint(functionsDir, slug)),
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
  const functionsDir = join(input.projectRoot, SUPABASE_FUNCTIONS_DIR);
  const seenDeprecatedImportMap = new Set<string>();
  const seenFallbackImportMap = new Set<string>();
  const resolved: ResolvedDeployFunctionConfig[] = [];

  const fallbackImportMapPath = join(functionsDir, "import_map.json");
  const fallbackExists = yield* Effect.promise(() => isFile(fallbackImportMapPath));

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
        hasOwnKey(input.rawConfigFunctions[slug], "verify_jwt") ? configured.verify_jwt : undefined,
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

        if (yield* Effect.promise(() => isFile(denoJson))) {
          importMap = denoJson;
        } else if (yield* Effect.promise(() => isFile(denoJsonc))) {
          importMap = denoJsonc;
        } else if (yield* Effect.promise(() => isFile(deprecatedImportMap))) {
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
});

const deployViaApi = Effect.fnUntraced(function* (
  projectRef: string,
  projectRoot: string,
  configs: ReadonlyArray<ResolvedDeployFunctionConfig>,
  api: ApiClient,
  jobs: number,
) {
  const output = yield* Output;
  // CLI-1985: uploaded file names and the server-recorded metadata paths
  // (`entrypoint_path`, `import_map_path`, `static_patterns`) are anchored at the
  // workdir (`projectRoot`), matching the pinned Go CLI's `toRelPath`, which is
  // relative to `os.Getwd()` after the CLI chdirs to the workdir
  // (`apps/cli-go/pkg/function/deploy.go:94-103`, `internal/utils/misc.go:238`).
  // Upstream Go never anchored deploy paths at the git root — that was a TS-only
  // divergence introduced by #5755. The import-walk *boundary* (which files may
  // be uploaded at all) intentionally stays at the nearest git root: the boundary
  // itself is a TS-only safeguard with no Go equivalent (Go's `WalkImportPaths`
  // uploads any reachable import unbounded; #5755 widened the TS boundary from
  // the workdir to the git root so monorepo imports outside the workdir deploy).
  // Such files upload with Go-`toRelPath`-style `../`-relative names.
  const sourceRoot = yield* Effect.tryPromise({
    try: () => resolveFunctionsSourceRoot(projectRoot),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
  const enabled = configs.filter((config) => config.enabled);
  for (const skipped of configs.filter((config) => !config.enabled)) {
    yield* output.raw(`Skipping disabled Function: ${skipped.slug}\n`, "stderr");
  }

  if (enabled.length === 0) {
    return yield* Effect.fail(
      new NoFunctionsToDeployError({ message: "All Functions are up to date." }),
    );
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

  // INC-699: each bundleOnly upload writes the bundle and bumps the remote version without
  // persisting metadata, which only the final bulk update does. Failing fast on the first
  // upload error strands that metadata remotely and makes every later deploy conflict, so
  // run every upload to completion, always persist what succeeded, then report the errors.
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

  // Go's `confirmPruneAll` + `fmt.Sprintln` (`deploy.go:189,206-212`): header, one
  // ` • <bold slug>` line per function, and a trailing blank line before the
  // `[y/N]` choices. Routed through `legacyPromptYesNo` (Go `PromptYesNo(msg,
  // false)`, `console.go:64-82`) so `--yes`/`SUPABASE_YES` auto-confirms with the
  // stderr echo and a non-TTY stdin honors a piped `y`/`n` answer (CLI-1974).
  const prompt = `${[
    "Do you want to delete the following Functions from your project?",
    ...toDelete.map((slug) => ` • ${legacyBold(slug)}`),
  ].join("\n")}\n\n`;
  const confirmed = yield* legacyPromptYesNo(output, yes, prompt, false);
  if (!confirmed) {
    return yield* Effect.fail(
      new FunctionDeployCancelledError({ message: CONTEXT_CANCELED_MESSAGE }),
    );
  }

  for (const slug of toDelete) {
    yield* output.raw(`Deleting Function: ${slug}\n`, "stderr");
    yield* deleteRemoteFunction(api, projectRef, slug);
  }
});

export function deployFunctions<ResolveError, ResolveRequirements>(
  flags: FunctionsDeployFlags,
  dependencies: DeployFunctionsDependencies<ResolveError, ResolveRequirements>,
) {
  return Effect.gen(function* () {
    const output = yield* Output;
    const styleIdentifier = dependencies.styleIdentifier ?? ((text: string) => text);
    const styleEmphasis = dependencies.styleEmphasis ?? ((text: string) => text);
    const commandPath = ["functions", "deploy"] as const;
    // Presence-based (true for `--use-api=false`, not just bare `--use-api`) — mirrors
    // cobra's `Changed()`-driven `MarkFlagsMutuallyExclusive`, so it's only used for the
    // mutual-exclusivity check below. Behavior branches (bundler routing, --jobs guard)
    // key off the resolved `flags.useApi` value instead, matching Go's own `if useApi`.
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
      return yield* Effect.fail(
        new ConflictingFunctionDeployFlagsError({
          message: cobraMutuallyExclusiveErrorMessage(FUNCTIONS_BUNDLER_MUTEX_GROUP, changedModes),
        }),
      );
    }

    // Go parity (`cmd/functions.go:79-80`): `if useApi { useDocker = false }` mutates the
    // resolved boolean, not a presence flag — `--use-api=false` alone must NOT force the
    // API path, it should fall through to whatever `--use-docker`/`--legacy-bundle`
    // already resolved to.
    const useLocalBundler = !flags.useApi && (flags.useDocker || flags.legacyBundle);
    const configuredJobs = Option.getOrElse(flags.jobs, () => 1);
    const jobs = configuredJobs === 0 ? 1 : configuredJobs;
    // Go parity (`cmd/functions.go:79-82`): the guard is `if useApi { ... } else if
    // maxJobs > 1 { error }` — keyed on the resolved `--use-api` value alone, not on
    // whether local bundling (Docker/legacy-bundle) is in play.
    if (!flags.useApi && jobs > 1) {
      return yield* Effect.fail(new Error("--jobs must be used together with --use-api"));
    }

    const projectRef = yield* dependencies.resolveProjectRef(flags.projectRef);
    // `@supabase/config` merges the matching `[remotes.*]` block over the base
    // config (Go's `loadFromFile` with `Config.ProjectId` set), so the resolved
    // config already reflects any remote function/edge_runtime overrides.
    // In the legacy shell this also runs the same `Config.Validate`/dotenv/
    // env-override pipeline `start`/`stop`/`status` already go through — see
    // `functions-config.ts`. Go: `flags.LoadConfig` runs before validating any
    // slug (`deploy.go:22-28`), so this must precede the loop below too — an
    // invalid `config.toml` is reported ahead of a malformed slug when both
    // are wrong (review round on CLI-1963).
    const context = yield* loadFunctionsProjectConfig({
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
    // Go gates the bundler's `--verbose` on `viper.GetBool("DEBUG")`
    // (`bundle.go:59`), so `--debug=false` must resolve to `false` — a plain
    // presence check would get that backwards (same rule as `download.ts`'s
    // own `--debug` read; the `SUPABASE_DEBUG` env fallback is deferred
    // there too).
    const debugEnabled = explicitBooleanLongFlag(dependencies.rawArgs, "debug") ?? false;
    const deployConfig = context.loaded?.config;
    const edgeRuntimeVersion = yield* resolveEdgeRuntimeVersion(
      context.denoVersion,
      dependencies.edgeRuntimeVersion,
    );
    const configFunctions = yield* inferFunctionsManifest({
      cwd: dependencies.projectRoot,
      config: deployConfig,
    });
    const configDeclaredFunctions = deployConfig?.functions ?? {};
    const rawConfigFunctions = rawFunctionConfigRecord(context.loaded?.document);
    yield* validateConfigFunctionSlugs(configDeclaredFunctions);
    const slugs =
      flags.functionNames.length > 0
        ? [...flags.functionNames]
        : yield* discoverFunctionSlugs(dependencies.projectRoot, configDeclaredFunctions);

    if (slugs.length === 0) {
      return yield* Effect.fail(
        new NoFunctionsToDeployError({
          // Go: `errors.Errorf("No Functions specified or found in %s",
          // utils.Bold(utils.FunctionsDir))` (`internal/functions/deploy/deploy.go:35`) —
          // the legacy handler injects the bold styling via `styleEmphasis`. Styling is
          // text-mode only: in `--output-format json`/`stream-json` this message lands in
          // the structured error payload, which must stay free of ANSI escapes.
          message: `No Functions specified or found in ${
            output.format === "text"
              ? styleEmphasis(SUPABASE_FUNCTIONS_DIR)
              : SUPABASE_FUNCTIONS_DIR
          }`,
        }),
      );
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

          // `lastExplicitLongFlagValue` preserves the "explicitly cleared" vs
          // "never touched" distinction `resolveDockerNetworkMode` needs to
          // decide whether `SUPABASE_NETWORK_ID` applies — see that
          // function's own doc comment. `SUPABASE_NETWORK_ID` (env or
          // project dotenv) is legacy-shell-only — same Go-viper-parity gate
          // as `context.projectEnvValues` itself (`undefined` in `next`).
          const networkMode = resolveDockerNetworkMode({
            explicit: lastExplicitLongFlagValue(dependencies.rawArgs, [], "network-id"),
            envOverride:
              context.projectEnvValues === undefined
                ? undefined
                : legacyViperEnvStringWithProjectFallback(
                    "SUPABASE_NETWORK_ID",
                    context.projectEnvValues,
                  ),
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
      // Go: `fmt.Printf("Deployed Functions on project %s: %s\n",
      // utils.Aqua(flags.ProjectRef), strings.Join(slugs, ", "))`
      // (`internal/functions/deploy/deploy.go:70`) — the legacy handler injects
      // the aqua styling via `styleIdentifier` (stdout-bound, so its TTY gate
      // must check stdout); next stays plain. Go joins the raw `slugs` list, not
      // the deduped set, so `functions deploy foo foo` prints "foo, foo".
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
  }).pipe(Effect.withSpan("functions.deploy"));
}
