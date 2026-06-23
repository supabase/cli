import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { URL } from "node:url";
import { FunctionResponse, operationDefinitions, type ApiClient } from "@supabase/api/effect";
import {
  inferFunctionsManifest,
  loadProjectConfig,
  type ResolvedFunctionConfig as ManifestFunctionConfig,
} from "@supabase/config";
import { Duration, Effect, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import { Output } from "../output/output.service.ts";
import { legacyGetRegistryImageUrl } from "../../legacy/shared/legacy-docker-registry.ts";
import { invalidFunctionSlugDetail, validateFunctionSlugMessage } from "./functions.shared.ts";
import {
  ConflictingFunctionDeployFlagsError,
  FunctionDeployCancelledError,
  InvalidFunctionDeploySlugError,
  NoFunctionsToDeployError,
} from "./deploy.errors.ts";

const COMPRESSED_ESZIP_MAGIC = "EZBR";
const DENO1_EDGE_RUNTIME_VERSION = "1.68.4";
const DEPLOY_RATE_LIMIT_MAX_RETRIES = 8;
const SUPABASE_FUNCTIONS_DIR = "supabase/functions";
const IMPORT_MAP_GUIDE_URL = "https://supabase.com/docs/guides/functions/import-maps";
const INVALID_PROJECT_ID = /[^a-zA-Z0-9_.-]+/g;
const MAX_PROJECT_ID_LENGTH = 40;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\//;
const importPathPattern =
  /(?:import|export)\s+(?:type\s+)?(?:{[^{}]+}|.*?)\s*(?:from)?\s*['"](.*?)['"]|import\(\s*['"](.*?)['"]\)/gi;

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
  readonly yes?: boolean;
  readonly rawArgs: ReadonlyArray<string>;
  readonly edgeRuntimeVersion: string;
  readonly resolveProjectRef: (
    projectRef: Option.Option<string>,
  ) => Effect.Effect<string, ResolveError, ResolveRequirements>;
}

interface ResolvedDeployFunctionConfig {
  readonly slug: string;
  readonly enabled: boolean;
  readonly verifyJwt?: boolean;
  readonly entrypoint: string;
  readonly importMap: string;
  readonly staticFiles: ReadonlyArray<string>;
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

function mapTransportError(prefix: string, error: unknown): Error {
  if (HttpClientError.isHttpClientError(error)) {
    const description = error.reason.description ?? error.reason._tag;
    return new Error(`${prefix}: ${description}`);
  }

  if (error instanceof Error) {
    return new Error(`${prefix}: ${error.message}`);
  }

  return new Error(`${prefix}: ${String(error)}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnKey(value: Readonly<Record<string, unknown>> | undefined, key: string) {
  return value !== undefined && Object.prototype.hasOwnProperty.call(value, key);
}

function rawFunctionConfigRecord(
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

function hasExplicitLongFlag(
  rawArgs: ReadonlyArray<string>,
  commandPath: ReadonlyArray<string>,
  flagName: string,
): boolean {
  const commandIndex = rawArgs.findIndex((_, index) =>
    commandPath.every((segment, offset) => rawArgs[index + offset] === segment),
  );
  if (commandIndex === -1) {
    return rawArgs.some((token) => token === `--${flagName}` || token.startsWith(`--${flagName}=`));
  }

  for (let index = commandIndex + commandPath.length; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (token === undefined || token === "--") {
      return false;
    }
    if (token === `--${flagName}` || token.startsWith(`--${flagName}=`)) {
      return true;
    }
  }
  return false;
}

function explicitBooleanFlag(
  rawArgs: ReadonlyArray<string>,
  commandPath: ReadonlyArray<string>,
  flagName: string,
  value: boolean,
) {
  return hasExplicitLongFlag(rawArgs, commandPath, flagName) ? Option.some(value) : Option.none();
}

function explicitStringFlag(rawArgs: ReadonlyArray<string>, flagName: string) {
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    if (token === `--${flagName}`) {
      return rawArgs[index + 1];
    }
    if (token?.startsWith(`--${flagName}=`)) {
      return token.slice(flagName.length + 3);
    }
  }
  return undefined;
}

function hasGlobalLongFlag(rawArgs: ReadonlyArray<string>, flagName: string) {
  return rawArgs.some((token) => token === `--${flagName}` || token.startsWith(`--${flagName}=`));
}

function isDenoConfigFile(pathname: string) {
  const name = basename(pathname).toLowerCase();
  return name === "deno.json" || name === "deno.jsonc";
}

function toSlash(pathname: string) {
  return pathname.replaceAll("\\", "/");
}

function normalizeProjectId(source: string) {
  const sanitized = source.replaceAll(INVALID_PROJECT_ID, "_").replace(/^[_.-]+/, "");
  return sanitized.length > MAX_PROJECT_ID_LENGTH
    ? sanitized.slice(0, MAX_PROJECT_ID_LENGTH)
    : sanitized;
}

function localDockerId(name: string, projectId: string) {
  return `supabase_${name}_${normalizeProjectId(projectId)}`;
}

const dockerCliProjectLabel = "com.supabase.cli.project";
const dockerComposeProjectLabel = "com.docker.compose.project";
const dockerNpmEnvNames = ["NPM_CONFIG_REGISTRY", "NPM_AUTH_TOKEN"] as const;

function dockerProjectLabels(projectId: string) {
  return {
    [dockerCliProjectLabel]: projectId,
    [dockerComposeProjectLabel]: projectId,
  };
}

function toDockerPath(hostPath: string) {
  const normalized = toSlash(resolve(hostPath));
  return normalized.replace(/^[A-Za-z]:/, "");
}

function toBundledFileUrl(hostPath: string) {
  const url = new URL("file:///");
  url.pathname = toDockerPath(hostPath).replaceAll("%", "%25");
  return url.toString();
}

function dockerBindHostPath(bind: string) {
  const withoutMode = bind.replace(/:(?:ro|rw)$/, "");
  const separatorIndex = withoutMode.lastIndexOf(":");
  return separatorIndex === -1 ? withoutMode : withoutMode.slice(0, separatorIndex);
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

async function realpathIfExists(pathname: string) {
  try {
    return await realpath(resolve(pathname));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return resolve(pathname);
    }
    throw error;
  }
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
    const [prefix] = entry;
    if (!specifier.startsWith(prefix)) {
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
    if (!currentPath.startsWith(scopeName) || scopeName.length <= scopedPrefixLength) {
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
        await onWarning(`WARN: Skipping import path outside project root: ${current}\n`);
        continue;
      }
      contents = await readFile(resolvedCurrent);
    } catch (error) {
      if (error instanceof Error) {
        if ("code" in error && error.code === "ENOENT") {
          const message = `failed to read file: open ${toApiRelativePath(displayRoot, current)}: no such file or directory`;
          await onWarning(`WARN: ${message}\n`);
          continue;
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

      if (!modulePath.includes(".")) {
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
        await onWarning(`WARN: Skipping import path outside project root: ${modulePath}\n`);
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
  onTarget: (pathname: string) => Promise<void>,
) {
  for (const target of Object.values(importMap.imports)) {
    if (isRemoteImportTarget(target)) {
      continue;
    }
    await onTarget(target);
  }
  for (const scope of Object.values(importMap.scopes)) {
    for (const target of Object.values(scope)) {
      if (isRemoteImportTarget(target)) {
        continue;
      }
      await onTarget(target);
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
  return allowedRoots;
}

async function writeSourceDeployForm(
  cwd: string,
  projectRoot: string,
  config: ResolvedDeployFunctionConfig,
  metadata: SourceDeployMetadata,
  outputRaw: (text: string) => Effect.Effect<void, never>,
) {
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  const realProjectRoot = await realpath(projectRoot);
  const importMapAllowedRoots = await resolveImportMapAllowedRoots(projectRoot, config.importMap);
  const uploadedAssets = new Set<string>();

  const appendAsset = async (pathname: string, contents: Uint8Array, realPathname: string) => {
    if (uploadedAssets.has(realPathname)) {
      return;
    }
    uploadedAssets.add(realPathname);
    const relativePath = toApiRelativePath(cwd, pathname);
    await Effect.runPromise(outputRaw(`Uploading asset (${config.slug}): ${relativePath}\n`));
    form.append("file", new File([contents], relativePath));
  };

  const uploadAsset = async (pathname: string, contents: Uint8Array) => {
    const realPathname = await realpath(pathname);
    if (!isContainedPath(realProjectRoot, realPathname)) {
      throw new Error(`refusing to upload asset outside project root: ${pathname}`);
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
        outputRaw(`WARN: Skipping import path outside project root: ${pathname}\n`),
      );
      return;
    }
    await appendAsset(pathname, contents, realPathname);
  };

  const uploadScopeTarget = async (pathname: string) => {
    const resolvedPath = await realpath(pathname);
    if (!isContainedInAnyPath(importMapAllowedRoots, resolvedPath)) {
      await Effect.runPromise(
        outputRaw(`WARN: Skipping import path outside project root: ${pathname}\n`),
      );
      return;
    }
    const pathInfo = await stat(pathname);
    if (!pathInfo.isDirectory()) {
      await uploadImportMapTargetAsset(pathname, await readFile(pathname));
      await walkLocalImportMapTargetImports(
        importMap,
        pathname,
        importMapAllowedRoots,
        projectRoot,
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
          outputRaw(`WARN: Skipping import path outside project root: ${nestedPath}\n`),
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
    [realProjectRoot],
    projectRoot,
    uploadAsset,
    async (message) => {
      await Effect.runPromise(outputRaw(message));
    },
  );
  await forEachLocalImportMapTarget(importMap, uploadScopeTarget);

  return form;
}

function createSourceMetadata(
  cwd: string,
  config: ResolvedDeployFunctionConfig,
  remote?: RemoteFunction,
): SourceDeployMetadata {
  const verifyJwt = config.verifyJwt ?? remote?.verify_jwt;
  return {
    name: config.slug,
    ...(verifyJwt === undefined ? {} : { verify_jwt: verifyJwt }),
    entrypoint_path: toApiRelativePath(cwd, config.entrypoint),
    import_map_path: config.importMap.length > 0 ? toApiRelativePath(cwd, config.importMap) : "",
    static_patterns: config.staticFiles.map((pathname) => toApiRelativePath(cwd, pathname)),
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

function collectByteStream(stream: Stream.Stream<Uint8Array, unknown>) {
  const decoder = new TextDecoder();
  return Stream.runFold(
    stream,
    () => "",
    (text, chunk) => text + decoder.decode(chunk, { stream: true }),
  ).pipe(Effect.map((text) => text + decoder.decode()));
}

function sanitizeDockerBinds(
  binds: ReadonlyArray<string>,
  functionsDir: string,
  outputDir: string,
) {
  const normalizedFunctionsDir = `${toSlash(resolve(functionsDir))}/`;
  const normalizedOutputDir = `${toSlash(resolve(outputDir))}/`;
  const seen = new Set<string>();
  const result: string[] = [];

  for (const bind of binds) {
    const hostPath = dockerBindHostPath(bind);
    const normalizedHostPath = `${toSlash(resolve(hostPath))}${bind.endsWith(":rw") || bind.endsWith(":ro") ? "" : "/"}`;
    if (
      normalizedHostPath.startsWith(normalizedFunctionsDir) ||
      normalizedHostPath.startsWith(normalizedOutputDir)
    ) {
      continue;
    }
    if (!seen.has(bind)) {
      seen.add(bind);
      result.push(bind);
    }
  }

  return result;
}

async function buildDockerBinds(
  projectId: string,
  functionsDir: string,
  outputDir: string,
  config: ResolvedDeployFunctionConfig,
) {
  const hostFunctionsDir = resolve(functionsDir);
  const hostOutputDir = resolve(outputDir);
  const projectRoot = resolve(functionsDir, "..", "..");
  const realProjectRoot = await realpath(projectRoot);
  const importMapAllowedRoots = await resolveImportMapAllowedRoots(projectRoot, config.importMap);
  const binds = [
    `${localDockerId("edge_runtime", projectId)}:/root/.cache/deno:rw`,
    `${hostFunctionsDir}:${toDockerPath(hostFunctionsDir)}:ro`,
  ];

  if (!hostOutputDir.startsWith(hostFunctionsDir)) {
    binds.push(`${hostOutputDir}:${toDockerPath(hostOutputDir)}:rw`);
  }

  const extraBinds: string[] = [];
  const appendBindWithinRoots = async (roots: ReadonlyArray<string>, pathname: string) => {
    const hostPath = await realpath(pathname);
    if (!isContainedInAnyPath(roots, hostPath)) {
      return;
    }
    extraBinds.push(`${hostPath}:${toDockerPath(hostPath)}:ro`);
  };
  const appendProjectBind = async (pathname: string, _contents: Uint8Array) =>
    appendBindWithinRoots([realProjectRoot], pathname);
  const appendImportMapBind = async (pathname: string, _contents: Uint8Array) =>
    appendBindWithinRoots(importMapAllowedRoots, pathname);
  const importMap =
    config.importMap.length > 0
      ? await loadImportMapFile(config.importMap, appendImportMapBind)
      : new ImportMapFile();
  await walkImportPaths(
    importMap,
    config.entrypoint,
    [realProjectRoot],
    projectRoot,
    appendProjectBind,
    async () => {},
  );
  await forEachLocalImportMapTarget(importMap, async (target) => {
    await appendBindWithinRoots(importMapAllowedRoots, target);
    if ((await stat(target)).isDirectory()) {
      return;
    }
    await walkLocalImportMapTargetImports(
      importMap,
      target,
      importMapAllowedRoots,
      projectRoot,
      appendImportMapBind,
      async () => {},
    );
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

  return [...binds, ...sanitizeDockerBinds(extraBinds, hostFunctionsDir, hostOutputDir)];
}

function shouldUseDenoJsonDiscovery(entrypoint: string, importMap: string) {
  return isDenoConfigFile(importMap) && dirname(importMap) === dirname(entrypoint);
}

function isUserDefinedDockerNetwork(networkMode: string) {
  return (
    networkMode.length > 0 &&
    networkMode !== "default" &&
    networkMode !== "bridge" &&
    networkMode !== "host" &&
    networkMode !== "none"
  );
}

const ensureDockerNetwork = Effect.fnUntraced(function* (networkMode: string, projectId: string) {
  if (!isUserDefinedDockerNetwork(networkMode)) {
    return;
  }

  const inspect = yield* runChildProcess("docker", ["network", "inspect", networkMode], {
    stdout: "ignore",
    stderr: "ignore",
  }).pipe(Effect.catch(() => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })));
  if (inspect.exitCode === 0) {
    return;
  }

  const labels = dockerProjectLabels(projectId);
  const create = yield* runChildProcess(
    "docker",
    [
      "network",
      "create",
      "--label",
      `${dockerCliProjectLabel}=${labels[dockerCliProjectLabel]}`,
      "--label",
      `${dockerComposeProjectLabel}=${labels[dockerComposeProjectLabel]}`,
      networkMode,
    ],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  if (create.exitCode !== 0 && !create.stderr.includes("already exists")) {
    return yield* Effect.fail(new Error(`failed to create docker network: ${networkMode}`));
  }
});

const ensureDockerNamedVolume = Effect.fnUntraced(function* (
  volumeName: string,
  projectId: string,
) {
  if (process.env["BITBUCKET_CLONE_DIR"] !== undefined) {
    return;
  }

  const labels = dockerProjectLabels(projectId);
  const create = yield* runChildProcess(
    "docker",
    [
      "volume",
      "create",
      "--label",
      `${dockerCliProjectLabel}=${labels[dockerCliProjectLabel]}`,
      "--label",
      `${dockerComposeProjectLabel}=${labels[dockerComposeProjectLabel]}`,
      volumeName,
    ],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  if (create.exitCode !== 0 && !create.stderr.includes("already exists")) {
    return yield* Effect.fail(new Error(`failed to create docker volume: ${volumeName}`));
  }
});

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

const runChildProcess = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  opts: {
    readonly stdout?: "pipe" | "ignore";
    readonly stderr?: "pipe" | "ignore";
    readonly env?: Readonly<Record<string, string>>;
  } = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, [...args], {
      stdin: "ignore",
      stdout: opts.stdout ?? "pipe",
      stderr: opts.stderr ?? "pipe",
      env: opts.env,
    }),
  );

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      opts.stdout === "ignore" ? Effect.succeed("") : collectByteStream(child.stdout),
      opts.stderr === "ignore" ? Effect.succeed("") : collectByteStream(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );
  return { exitCode, stdout, stderr };
});

const isDockerRunning = Effect.fnUntraced(function* () {
  const result = yield* runChildProcess("docker", ["info"], {
    stdout: "ignore",
    stderr: "ignore",
  }).pipe(Effect.catch(() => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })));
  return result.exitCode === 0;
});

const bundleFunctionWithDocker = Effect.fnUntraced(function* (
  projectId: string,
  edgeRuntimeVersion: string,
  functionsDir: string,
  config: ResolvedDeployFunctionConfig,
  dockerNetworkId?: string,
  verbose = false,
) {
  const output = yield* Output;
  yield* output.raw(`Bundling Function: ${config.slug}\n`, "stderr");

  const outputDir = yield* Effect.tryPromise(() =>
    mkdtemp(join(tmpdir(), `.supabase-output-${config.slug}-`)),
  );
  try {
    yield* Effect.tryPromise(() => chmod(outputDir, 0o777));
    const outputPath = join(outputDir, "output.eszip");
    const binds = yield* Effect.promise(() =>
      buildDockerBinds(projectId, functionsDir, outputDir, config),
    );
    const networkMode = dockerNetworkId ?? localDockerId("network", projectId);
    yield* ensureDockerNetwork(networkMode, projectId);
    yield* ensureDockerNamedVolume(localDockerId("edge_runtime", projectId), projectId);
    const command = ["run", "--rm", ...binds.flatMap((bind) => ["-v", bind])];
    command.push("--network", networkMode);
    if (process.platform === "linux") {
      command.push("--add-host", "host.docker.internal:host-gateway");
    }

    if (
      !(yield* Effect.promise(() =>
        shouldUsePackageJsonDiscovery(config.entrypoint, config.importMap),
      ))
    ) {
      command.push("-e", "DENO_NO_PACKAGE_JSON=1");
    }
    for (const env of dockerNpmEnv()) {
      command.push("-e", env);
    }

    command.push(
      legacyGetRegistryImageUrl(`supabase/edge-runtime:v${edgeRuntimeVersion}`),
      "bundle",
      "--entrypoint",
      toDockerPath(config.entrypoint),
      "--output",
      toDockerPath(outputPath),
    );
    if (
      config.importMap.length > 0 &&
      !shouldUseDenoJsonDiscovery(config.entrypoint, config.importMap)
    ) {
      command.push("--import-map", toDockerPath(config.importMap));
    }
    for (const staticFile of config.staticFiles) {
      command.push("--static", toDockerPath(staticFile));
    }
    if (verbose || process.env["DEBUG"] === "true") {
      command.push("--verbose");
    }

    const result = yield* runChildProcess("docker", command, { stdout: "pipe", stderr: "pipe" });
    if (result.stdout.length > 0) {
      yield* output.raw(result.stdout, output.format === "text" ? "stdout" : "stderr");
    }
    if (result.stderr.length > 0) {
      yield* output.raw(result.stderr, "stderr");
    }
    if (result.exitCode !== 0) {
      return yield* Effect.fail(new Error(`failed to bundle function: exit ${result.exitCode}`));
    }

    const eszip = yield* Effect.tryPromise(() => readFile(outputPath));
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
  let lastError: Error | undefined;
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
        return yield* Effect.try({
          try: () => decodeFunctionListResponse(JSON.parse(body)),
          catch: (error) =>
            new Error(
              `failed to read functions list: ${error instanceof Error ? error.message : String(error)}`,
            ),
        });
      }
      lastError = new Error(`unexpected list functions status ${result.response.status}: ${body}`);
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
  cwd: string,
  projectRoot: string,
  config: ResolvedDeployFunctionConfig,
  metadata: SourceDeployMetadata,
  bundleOnly: boolean,
) {
  const output = yield* Output;
  const files = yield* Effect.tryPromise({
    try: async () => {
      const form = await writeSourceDeployForm(cwd, projectRoot, config, metadata, (text) =>
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
          ...(files.length > 0 ? { file: files } : {}),
        },
      })
      .pipe(
        Effect.map((raw) => ({
          status: raw.status,
          headers: raw.headers,
          body: raw.json.pipe(
            Effect.mapError((error) => mapTransportError("failed to deploy function", error)),
          ),
        })),
        Effect.mapError((error) => mapTransportError("failed to deploy function", error)),
      ),
  );
  const body = yield* response.body;
  if (response.status !== 201) {
    return yield* Effect.fail(
      new Error(`unexpected deploy status ${response.status}: ${JSON.stringify(body)}`),
    );
  }
  return yield* Effect.try({
    try: () => decodeDeployFunctionResponse(body),
    catch: (error) =>
      new Error(
        `failed to read deploy response: ${error instanceof Error ? error.message : String(error)}`,
      ),
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
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    const result = yield* rateLimitedRequest("bulk updating functions", () =>
      api
        .executeRaw(operationDefinitions.v1BulkUpdateFunctions, {
          ref: projectRef,
          body: functions.map(toBulkUpdateItem),
        })
        .pipe(
          Effect.map((raw) => ({
            status: raw.status,
            headers: raw.headers,
            body: raw.text.pipe(
              Effect.mapError((error) => mapTransportError("failed to bulk update", error)),
            ),
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
      lastError = new Error(`unexpected bulk update status ${result.response.status}: ${body}`);
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
  let lastError: Error | undefined;

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
        const body = yield* response.value.json.pipe(
          Effect.mapError((error) => mapTransportError("failed to read function response", error)),
        );
        return decodeDeployFunctionResponse(body);
      }

      const body = yield* response.value.text.pipe(Effect.orElseSucceed(() => ""));
      if (!shouldUpdate && body.includes("Duplicated function slug")) {
        shouldUpdate = true;
      }
      lastError = new Error(
        `unexpected ${action} function status ${response.value.status}: ${body}`,
      );
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
    new Error(`unexpected delete function status ${response.status}: ${body}`),
  );
});

const discoverFunctionSlugs = Effect.fnUntraced(function* (
  projectRoot: string,
  configDeclaredFunctions: Readonly<Record<string, ManifestFunctionConfig>>,
) {
  const functionsDir = join(projectRoot, SUPABASE_FUNCTIONS_DIR);
  const slugs: string[] = [];

  const entries = yield* Effect.tryPromise(() =>
    readdir(functionsDir, { withFileTypes: true }),
  ).pipe(
    Effect.catch((error) => {
      const cause =
        typeof error === "object" && error !== null && "error" in error ? error.error : error;
      return cause instanceof Error && "code" in cause && cause.code === "ENOENT"
        ? Effect.succeed(undefined)
        : Effect.fail(error);
    }),
  );
  if (entries !== undefined) {
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) {
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

const resolveFunctionConfigs = Effect.fnUntraced(function* (input: {
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
  cwd: string,
  projectRoot: string,
  configs: ReadonlyArray<ResolvedDeployFunctionConfig>,
  api: ApiClient,
  jobs: number,
) {
  const output = yield* Output;
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
      cwd,
      projectRoot,
      config,
      createSourceMetadata(cwd, config, remoteBySlug.get(config.slug)),
      false,
    );
    return;
  }

  const deployed = yield* Effect.forEach(
    enabled,
    (config) =>
      Effect.gen(function* () {
        yield* output.raw(`Deploying Function: ${config.slug}\n`, "stderr");
        return toBulkUpdateItem(
          yield* uploadFunctionSource(
            api,
            projectRef,
            cwd,
            projectRoot,
            config,
            createSourceMetadata(cwd, config, remoteBySlug.get(config.slug)),
            true,
          ),
        );
      }),
    { concurrency: jobs },
  );
  yield* bulkUpdateRemoteFunctions(api, projectRef, deployed);
});

const deployViaDocker = Effect.fnUntraced(function* (
  projectId: string,
  projectRef: string,
  edgeRuntimeVersion: string,
  functionsDir: string,
  configs: ReadonlyArray<ResolvedDeployFunctionConfig>,
  api: ApiClient,
  dockerNetworkId?: string,
  verbose = false,
) {
  const output = yield* Output;
  const remoteFunctions = yield* listRemoteFunctions(api, projectRef);
  const remoteBySlug = new Map(remoteFunctions.map((fn) => [fn.slug, fn]));
  const changed: BulkUpdateFunction[] = [];

  for (const config of configs) {
    if (!config.enabled) {
      yield* output.raw(`Skipping disabled Function: ${config.slug}\n`, "stderr");
      continue;
    }

    const bundled = yield* bundleFunctionWithDocker(
      projectId,
      edgeRuntimeVersion,
      functionsDir,
      config,
      dockerNetworkId,
      verbose,
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

function resolveEdgeRuntimeVersion(
  denoVersion: number | undefined,
  defaultVersion: string,
): Effect.Effect<string, Error> {
  if (denoVersion === undefined || denoVersion === 2) {
    return Effect.succeed(defaultVersion);
  }
  if (denoVersion === 1) {
    return Effect.succeed(DENO1_EDGE_RUNTIME_VERSION);
  }
  return Effect.fail(
    new Error(`Failed reading config: Invalid edge_runtime.deno_version: ${denoVersion}.`),
  );
}

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

  const prompt = [
    "Do you want to delete the following Functions from your project?",
    ...toDelete.map((slug) => ` - ${slug}`),
  ].join("\n");
  const confirmed = yes || (yield* output.promptConfirm(`${prompt}\n`, { defaultValue: false }));
  if (!confirmed) {
    return yield* Effect.fail(new FunctionDeployCancelledError({ message: "context canceled" }));
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
    const commandPath = ["functions", "deploy"] as const;
    const explicitUseApi = hasExplicitLongFlag(dependencies.rawArgs, commandPath, "use-api");
    const explicitUseDocker = hasExplicitLongFlag(dependencies.rawArgs, commandPath, "use-docker");
    const explicitLegacyBundle = hasExplicitLongFlag(
      dependencies.rawArgs,
      commandPath,
      "legacy-bundle",
    );

    const selectedModes = [
      explicitUseApi ? "--use-api" : undefined,
      explicitUseDocker ? "--use-docker" : undefined,
      explicitLegacyBundle ? "--legacy-bundle" : undefined,
    ].filter((flag) => flag !== undefined);

    if (selectedModes.length > 1) {
      return yield* Effect.fail(
        new ConflictingFunctionDeployFlagsError({
          message: `flags ${selectedModes.join(", ")} are mutually exclusive`,
        }),
      );
    }

    const useLocalBundler = !explicitUseApi && (flags.useDocker || flags.legacyBundle);
    const configuredJobs = Option.getOrElse(flags.jobs, () => 1);
    const jobs = configuredJobs === 0 ? 1 : configuredJobs;
    if (useLocalBundler && jobs > 1) {
      return yield* Effect.fail(new Error("--jobs cannot be used with local bundling"));
    }

    const preResolvedProjectRef =
      flags.functionNames.length > 0
        ? yield* dependencies.resolveProjectRef(flags.projectRef)
        : undefined;

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
    const debugEnabled = hasGlobalLongFlag(dependencies.rawArgs, "debug");
    const projectRef =
      preResolvedProjectRef ?? (yield* dependencies.resolveProjectRef(flags.projectRef));
    // `@supabase/config` merges the matching `[remotes.*]` block over the base
    // config (Go's `loadFromFile` with `Config.ProjectId` set), so the resolved
    // config already reflects any remote function/edge_runtime overrides.
    const loadedConfig = yield* loadProjectConfig(dependencies.projectRoot, { projectRef });
    const deployConfig = loadedConfig?.config;
    const edgeRuntimeVersion = yield* resolveEdgeRuntimeVersion(
      deployConfig?.edge_runtime.deno_version,
      dependencies.edgeRuntimeVersion,
    );
    const configFunctions = yield* inferFunctionsManifest({
      cwd: dependencies.projectRoot,
      config: deployConfig,
    });
    const configDeclaredFunctions = deployConfig?.functions ?? {};
    const rawConfigFunctions = rawFunctionConfigRecord(loadedConfig?.document);
    yield* validateConfigFunctionSlugs(configDeclaredFunctions);
    const slugs =
      flags.functionNames.length > 0
        ? [...flags.functionNames]
        : yield* discoverFunctionSlugs(dependencies.projectRoot, configDeclaredFunctions);

    if (slugs.length === 0) {
      return yield* Effect.fail(
        new NoFunctionsToDeployError({
          message: `No Functions specified or found in ${SUPABASE_FUNCTIONS_DIR}`,
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
      dependencies.cwd,
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

    const deployed = useLocalBundler
      ? yield* Effect.gen(function* () {
          if (!(yield* isDockerRunning())) {
            yield* output.raw("WARNING: Docker is not running\n", "stderr");
            return yield* deployWithApi;
          }

          const projectId = deployConfig?.project_id ?? projectRef;
          yield* deployViaDocker(
            projectId,
            projectRef,
            edgeRuntimeVersion,
            join(dependencies.projectRoot, SUPABASE_FUNCTIONS_DIR),
            configs,
            dependencies.api,
            explicitStringFlag(dependencies.rawArgs, "network-id"),
            debugEnabled,
          );
          return true;
        })
      : yield* deployWithApi;

    if (!deployed) {
      return;
    }

    if (output.format === "text") {
      yield* output.raw(`Deployed Functions on project ${projectRef}: ${uniqueSlugs.join(", ")}\n`);
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
