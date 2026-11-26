import { randomBytes } from "node:crypto";
import { access, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ConfigFormat } from "./config-format.ts";
import { parseJsonc } from "./jsonc.ts";
import { updateJsonDocument } from "./config-edit.ts";
import {
  buildFunctionsManifest,
  filesystemFunctionConfig,
  functionSlugPattern,
} from "./functions-manifest-core.ts";
import {
  edgeFunctionDenoConfigFileName,
  edgeFunctionEntrypointFileName,
  edgeFunctionsDirectoryName,
  type FunctionsManifest,
  type ResolvedFunctionConfig,
} from "./functions-manifest-model.ts";
import { isObject } from "./lib/document-value.ts";
import { setOwnProperty } from "./lib/own-property.ts";
import {
  layerProjectEnvironment,
  parseDotEnvText,
  type CliProjectEnvSource,
} from "./lib/dotenv.ts";
import { CliConfigFileConflictError, CliProjectEnvParseError } from "./promise-errors.ts";
import {
  decodeParsedCliConfig,
  defaultCliConfigDocument,
  encodeCliConfigText,
  failIfSchemaTooNew,
  formatForConfigPath,
  parseConfigText,
  readConfigDocumentText,
  readConfigText,
  schemaRefOfDocument,
  type CliConfigDocument,
  type LoadedCliConfig,
} from "./plain-config.ts";
import {
  readCliConfigSchemaDeclaration,
  SCHEMA_DIRECTIVE_LINE,
  versionOfSchemaRef,
} from "./schema-version.ts";

export type { CliConfigDocument, LoadedCliConfig } from "./plain-config.ts";
export type { FunctionsManifest, ResolvedFunctionConfig } from "./functions-manifest-model.ts";

export interface CliProjectPaths {
  readonly projectRoot: string;
  readonly supabaseDir: string;
  readonly configPath: string;
  readonly envPath: string;
  readonly envLocalPath: string;
}

export interface CliProjectEnvironment {
  readonly paths: CliProjectPaths;
  readonly values: Readonly<Record<string, string>>;
  readonly loadedPaths: ReadonlyArray<string>;
  readonly sources: Readonly<Record<string, CliProjectEnvSource>>;
}

export interface LoadCliProjectEnvironmentOptions {
  readonly cwd: string;
  /** The ambient environment layered over the project's dotenv files; defaults to `process.env`. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** When `false`, only `cwd` itself is checked for a project; ancestors are not searched. */
  readonly search?: boolean;
  /** Skip reading `supabase/.env.local`, so a malformed one cannot fail config loading. */
  readonly skipEnvLocal?: boolean;
}

export interface LoadCliConfigOptions {
  /** Merges the `[remotes.<name>]` block whose `project_id` matches this ref over the base config. */
  readonly projectRef?: string;
  /** Pre-resolved project environment used to interpolate `env()` references. */
  readonly cliProjectEnv?: CliProjectEnvironment;
  /** When `false`, only `cwd` itself is checked for a project; ancestors are not searched. */
  readonly search?: boolean;
  /** Ignore `config.json`/`config.jsonc` and only load `config.toml`. */
  readonly tomlOnly?: boolean;
}

export interface SaveCliConfigOptions {
  readonly cwd: string;
  readonly config: CliConfigDocument;
  readonly format?: ConfigFormat;
  readonly schemaRef?: string;
}

/** Promise API over `node:fs/promises` that never imports `effect`. */
export interface CliConfigIo {
  readonly loadCliConfig: (
    cwd: string,
    options?: LoadCliConfigOptions,
  ) => Promise<LoadedCliConfig | null>;
  readonly findCliProjectRoot: (cwd: string) => Promise<string | null>;
  readonly findCliProjectPaths: (cwd: string) => Promise<CliProjectPaths | null>;
  readonly loadCliConfigFile: (path: string) => Promise<LoadedCliConfig>;
  readonly loadCliProjectEnvironment: (
    options: LoadCliProjectEnvironmentOptions,
  ) => Promise<CliProjectEnvironment | null>;
  readonly saveCliConfig: (options: SaveCliConfigOptions) => Promise<LoadedCliConfig>;
  readonly inferFunctionsManifest: (cwd: string) => Promise<FunctionsManifest>;
}

const DEFAULT_FILE_MODE = 0o644;
const TEMP_FILE_ATTEMPTS = 5;

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function probe(path: string, isAbsent: (error: unknown) => boolean): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isAbsent(error)) {
      return false;
    }
    throw error;
  }
}

const exists = (path: string) =>
  probe(
    path,
    (error) =>
      isNotFound(error) || (error instanceof Error && "code" in error && error.code === "ENOTDIR"),
  );

/** Discovery reads any probe failure as "no config here", as the Effect entries do. */
const discoveryExists = (path: string) => probe(path, () => true);

async function findConfigInRoot(root: string): Promise<CliProjectPaths | null> {
  const supabaseDir = join(root, "supabase");
  const jsonPath = join(supabaseDir, "config.json");
  const jsoncPath = join(supabaseDir, "config.jsonc");
  const tomlPath = join(supabaseDir, "config.toml");
  const [jsonExists, jsoncExists, tomlExists] = await Promise.all([
    discoveryExists(jsonPath),
    discoveryExists(jsoncPath),
    discoveryExists(tomlPath),
  ]);
  if (!jsonExists && !jsoncExists && !tomlExists) {
    return null;
  }
  return {
    projectRoot: root,
    supabaseDir,
    configPath: jsonExists ? jsonPath : jsoncExists ? jsoncPath : tomlPath,
    envPath: join(supabaseDir, ".env"),
    envLocalPath: join(supabaseDir, ".env.local"),
  };
}

async function findProjectPaths(
  cwd: string,
  options?: { readonly search?: boolean },
): Promise<CliProjectPaths | null> {
  let current = resolve(cwd);
  if (options?.search === false) {
    return findConfigInRoot(current);
  }
  while (true) {
    const match = await findConfigInRoot(current);
    if (match !== null) {
      return match;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function readDotEnv(path: string): Promise<Record<string, string>> {
  const parsed = parseDotEnvText(await readFile(path, "utf8"));
  if ("errorLine" in parsed) {
    throw new CliProjectEnvParseError({ path, line: parsed.errorLine });
  }
  return parsed.values;
}

async function loadProjectEnvironment(
  options: LoadCliProjectEnvironmentOptions,
): Promise<CliProjectEnvironment | null> {
  const paths = await findProjectPaths(options.cwd, { search: options.search });
  if (paths === null) {
    return null;
  }
  const loadedPaths: Array<string> = [];
  let env: Record<string, string> | undefined;
  let envLocal: Record<string, string> | undefined;
  if (await exists(paths.envPath)) {
    env = await readDotEnv(paths.envPath);
    loadedPaths.push(paths.envPath);
  }
  if (options.skipEnvLocal !== true && (await exists(paths.envLocalPath))) {
    envLocal = await readDotEnv(paths.envLocalPath);
    loadedPaths.push(paths.envLocalPath);
  }
  const { values, sources } = layerProjectEnvironment({
    env,
    envLocal,
    baseEnv: options.baseEnv ?? process.env,
  });
  return { paths, values, loadedPaths, sources };
}

async function locateConfigFile(
  cwd: string,
  options: { readonly search?: boolean; readonly tomlOnly?: boolean } | undefined,
): Promise<{ readonly filePath: string; readonly ignoredPaths: ReadonlyArray<string> } | null> {
  const project = await findProjectPaths(cwd, { search: options?.search });
  if (project === null) {
    return null;
  }
  const jsonPath = join(project.supabaseDir, "config.json");
  const jsoncPath = join(project.supabaseDir, "config.jsonc");
  const tomlPath = join(project.supabaseDir, "config.toml");
  const tomlExists = await exists(tomlPath);

  if (options?.tomlOnly !== true) {
    const [jsonExists, jsoncExists] = await Promise.all([exists(jsonPath), exists(jsoncPath)]);
    if (jsonExists && jsoncExists) {
      throw new CliConfigFileConflictError({ paths: [jsonPath, jsoncPath] });
    }
    if (jsonExists || jsoncExists) {
      return {
        filePath: jsonExists ? jsonPath : jsoncPath,
        ignoredPaths: tomlExists ? [tomlPath] : [],
      };
    }
  }
  return tomlExists ? { filePath: tomlPath, ignoredPaths: [] } : null;
}

async function loadConfigFile(
  path: string,
  options?: LoadCliConfigOptions,
): Promise<LoadedCliConfig> {
  const text = await readFile(path, "utf8");
  const parsed = readConfigText(path, text);
  const cliProjectEnv =
    options?.cliProjectEnv ??
    (await loadProjectEnvironment({
      cwd: dirname(dirname(path)),
      baseEnv: process.env,
      search: options?.search,
    }));
  return decodeParsedCliConfig({
    path,
    text,
    parsed,
    env: cliProjectEnv?.values ?? {},
    ...(options?.projectRef === undefined ? {} : { projectRef: options.projectRef }),
  });
}

async function loadConfig(
  cwd: string,
  options: LoadCliConfigOptions | undefined,
): Promise<LoadedCliConfig | null> {
  const located = await locateConfigFile(cwd, options);
  if (located === null) {
    return null;
  }
  return {
    ...(await loadConfigFile(located.filePath, options)),
    ignoredPaths: located.ignoredPaths,
  };
}

async function openExclusiveTempFile(filePath: string, mode: number) {
  for (let attempt = 1; ; attempt++) {
    const tmpPath = `${filePath}.tmp.${Date.now()}.${randomBytes(3).toString("hex")}`;
    try {
      return { tmpPath, handle: await open(tmpPath, "wx", mode) };
    } catch (error) {
      if (attempt === TEMP_FILE_ATTEMPTS || !isAlreadyExists(error)) {
        throw error;
      }
    }
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const existingMode = await stat(filePath).then(
    (info) => info.mode & 0o7777,
    (error: unknown) => {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    },
  );
  const { tmpPath, handle } = await openExclusiveTempFile(
    filePath,
    existingMode ?? DEFAULT_FILE_MODE,
  );
  try {
    try {
      await handle.writeFile(content);
      if (existingMode !== undefined) {
        await handle.chmod(existingMode);
      }
    } finally {
      await handle.close();
    }
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

async function rejectNewerExistingSchema(paths: ReadonlyArray<string>): Promise<void> {
  for (const filePath of paths) {
    if (!(await exists(filePath))) {
      continue;
    }
    const format = formatForConfigPath(filePath);
    const content = await readFile(filePath, "utf8");
    let document: unknown;
    try {
      document = parseConfigText(content, format, filePath);
    } catch {
      document = undefined;
    }
    failIfSchemaTooNew(filePath, format, readCliConfigSchemaDeclaration(content, format, document));
  }
}

async function readExistingSchemaRef(cwd: string): Promise<string | undefined> {
  const located = await locateConfigFile(cwd, undefined);
  if (located === null) {
    return undefined;
  }
  const text = await readFile(located.filePath, "utf8");
  return schemaRefOfDocument(readConfigDocumentText(located.filePath, text).document);
}

async function saveConfig(options: SaveCliConfigOptions): Promise<LoadedCliConfig> {
  const project = await findProjectPaths(options.cwd);
  const baseCwd = project?.projectRoot ?? options.cwd;
  const jsonPath = join(baseCwd, "supabase", "config.json");
  const jsoncPath = join(baseCwd, "supabase", "config.jsonc");
  const tomlPath = join(baseCwd, "supabase", "config.toml");
  const [jsonExists, jsoncExists, tomlExists] = await Promise.all([
    exists(jsonPath),
    exists(jsoncPath),
    exists(tomlPath),
  ]);
  if (jsonExists && jsoncExists) {
    throw new CliConfigFileConflictError({ paths: [jsonPath, jsoncPath] });
  }
  const format: ConfigFormat =
    options.format ?? (jsonExists || jsoncExists || !tomlExists ? "json" : "toml");
  const filePath = format === "toml" ? tomlPath : jsoncExists ? jsoncPath : jsonPath;
  const allPaths = [jsonPath, jsoncPath, tomlPath];

  if (project !== null) {
    await rejectNewerExistingSchema(allPaths);
  }
  const schemaRef =
    options.schemaRef ?? (project === null ? undefined : await readExistingSchemaRef(baseCwd));
  if (schemaRef !== undefined) {
    failIfSchemaTooNew(filePath, formatForConfigPath(filePath), {
      ref: schemaRef,
      version: versionOfSchemaRef(schemaRef),
    });
  }

  let content = encodeCliConfigText(options.config, format, schemaRef, filePath);
  const existingText = (await exists(filePath))
    ? await readFile(filePath, "utf8").catch(() => undefined)
    : undefined;
  if (existingText !== undefined) {
    if (format === "json") {
      content = updateJsonDocument(existingText, parseJsonc(content)) ?? content;
    } else {
      const directive = SCHEMA_DIRECTIVE_LINE.exec(existingText);
      if (directive !== null && !content.startsWith("#:schema")) {
        const replacement =
          options.schemaRef !== undefined && directive[1] !== options.schemaRef
            ? `#:schema ${options.schemaRef}`
            : directive[0];
        content = `${replacement}\n${content}`;
      }
    }
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, content);
  for (const otherPath of allPaths) {
    if (otherPath !== filePath && (await exists(otherPath))) {
      await rm(otherPath);
    }
  }

  return {
    path: filePath,
    format,
    config: options.config,
    ...(schemaRef === undefined ? {} : { schemaRef }),
    ignoredPaths: [],
    deprecatedPaths: [],
  };
}

function functionConfigsOf(config: CliConfigDocument): Record<string, ResolvedFunctionConfig> {
  const functions = config["functions"];
  return Object.fromEntries(
    Object.entries(isObject(functions) ? functions : {}).flatMap(([slug, entry]) => {
      if (!isObject(entry)) {
        return [];
      }
      const staticFiles = entry["static_files"];
      const env = entry["env"];
      return [
        [
          slug,
          {
            enabled: entry["enabled"] !== false,
            verify_jwt: entry["verify_jwt"] !== false,
            import_map: typeof entry["import_map"] === "string" ? entry["import_map"] : "",
            entrypoint: typeof entry["entrypoint"] === "string" ? entry["entrypoint"] : "",
            static_files: Array.isArray(staticFiles)
              ? staticFiles.filter((file) => typeof file === "string")
              : [],
            env: Object.fromEntries(
              Object.entries(isObject(env) ? env : {}).filter(
                (pair): pair is [string, string] => typeof pair[1] === "string",
              ),
            ),
          },
        ],
      ];
    }),
  );
}

async function inferManifest(cwd: string): Promise<FunctionsManifest> {
  const project = await findProjectPaths(cwd);
  const projectRoot = project?.projectRoot ?? cwd;
  const loaded = await loadConfig(cwd, undefined);
  const config = loaded?.config ?? defaultCliConfigDocument();
  const functionsDir = join(projectRoot, "supabase", edgeFunctionsDirectoryName);
  const filesystemFunctions: Record<string, ResolvedFunctionConfig> = {};

  if (await exists(functionsDir)) {
    const entries = await readdir(functionsDir);
    for (const slug of entries.sort((left, right) => left.localeCompare(right))) {
      if (
        !functionSlugPattern.test(slug) ||
        !(await exists(join(functionsDir, slug, edgeFunctionEntrypointFileName)))
      ) {
        continue;
      }
      setOwnProperty(
        filesystemFunctions,
        slug,
        filesystemFunctionConfig(
          slug,
          await exists(join(functionsDir, slug, edgeFunctionDenoConfigFileName)),
        ),
      );
    }
  }
  return buildFunctionsManifest(filesystemFunctions, functionConfigsOf(config));
}

export const cliConfigIo: CliConfigIo = {
  loadCliConfig: loadConfig,
  findCliProjectRoot: async (cwd) => (await findProjectPaths(cwd))?.projectRoot ?? null,
  findCliProjectPaths: (cwd) => findProjectPaths(cwd),
  loadCliConfigFile: (path) => loadConfigFile(path),
  loadCliProjectEnvironment: loadProjectEnvironment,
  saveCliConfig: saveConfig,
  inferFunctionsManifest: inferManifest,
};
