import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as SmolToml from "smol-toml";
import type { ConfigFormat } from "./config-format.ts";
import { updateJsonDocument } from "./config-edit.ts";
import { JsoncSyntaxError, parseJsonc } from "./jsonc.ts";
import { cliConfigSchemaKey, isObject } from "./lib/document-value.ts";
import { SCHEMA_DIRECTIVE_LINE } from "./schema-version.ts";

/** A config document as read from or written to disk; shape is enforced by the published JSON Schema. */
export type CliConfigDocument = { readonly [key: string]: unknown };

/** One schema violation: a dotted `path` into the document and a human-readable `message`. */
export interface CliConfigValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface CliProjectPaths {
  readonly projectRoot: string;
  readonly supabaseDir: string;
  readonly configPath: string;
  readonly envPath: string;
  readonly envLocalPath: string;
}

export interface LoadedCliConfigDocument {
  readonly path: string;
  readonly format: ConfigFormat;
  readonly config: CliConfigDocument;
  readonly schemaRef?: string;
  /** Sibling config files that were found but not loaded because another format took precedence. */
  readonly ignoredPaths: ReadonlyArray<string>;
  readonly rawText: string;
}

export interface LoadCliConfigDocumentOptions {
  /** When `false`, only `cwd` itself is checked for a project; ancestors are not searched. */
  readonly search?: boolean;
  /** Ignore `config.json`/`config.jsonc` and only load `config.toml`. */
  readonly tomlOnly?: boolean;
}

export interface SaveCliConfigDocumentOptions {
  readonly cwd: string;
  readonly config: CliConfigDocument;
  readonly format?: ConfigFormat;
  readonly schemaRef?: string;
}

/** Why a {@link CliConfigIoError} was raised. */
export type CliConfigIoErrorReason = "parse_error" | "invalid_config" | "file_conflict";

/** Thrown for an unparsable, schema-invalid, or ambiguous config; OS failures propagate as the native error. */
// oxlint-disable-next-line effecttsgo/extends-native-error -- thrown by the effect-free `./io-promises` entry; `_tag` keeps Effect `catchTag` working.
export class CliConfigIoError extends Error {
  readonly _tag = "CliConfigIoError";
  override readonly name = "CliConfigIoError";
  readonly reason: CliConfigIoErrorReason;
  readonly path: string;
  readonly issues: ReadonlyArray<CliConfigValidationIssue>;

  constructor(
    reason: CliConfigIoErrorReason,
    path: string,
    message: string,
    issues: ReadonlyArray<CliConfigValidationIssue> = [],
  ) {
    super(message);
    this.reason = reason;
    this.path = path;
    this.issues = issues;
  }
}

/** Promise API over `node:fs/promises` that never imports `effect`. */
export interface CliConfigPromiseIo {
  readonly findCliProjectPaths: (
    cwd: string,
    options?: Pick<LoadCliConfigDocumentOptions, "search">,
  ) => Promise<CliProjectPaths | null>;
  readonly findCliProjectRoot: (
    cwd: string,
    options?: Pick<LoadCliConfigDocumentOptions, "search">,
  ) => Promise<string | null>;
  readonly loadCliConfig: (
    cwd: string,
    options?: LoadCliConfigDocumentOptions,
  ) => Promise<LoadedCliConfigDocument | null>;
  readonly loadCliConfigFile: (path: string) => Promise<LoadedCliConfigDocument>;
  readonly validateCliConfig: (config: unknown) => Promise<ReadonlyArray<CliConfigValidationIssue>>;
  readonly saveCliConfig: (
    options: SaveCliConfigDocumentOptions,
  ) => Promise<LoadedCliConfigDocument>;
}

const DEFAULT_FILE_MODE = 0o644;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function formatForPath(filePath: string): ConfigFormat {
  return filePath.endsWith(".json") || filePath.endsWith(".jsonc") ? "json" : "toml";
}

function dottedPath(instancePath: string): string {
  return instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
}

function issuesFrom(errors: ReadonlyArray<ErrorObject>): ReadonlyArray<CliConfigValidationIssue> {
  const messagesByPath = new Map<string, string[]>();
  for (const error of errors) {
    if (error.keyword === "anyOf" || error.keyword === "oneOf") {
      continue;
    }
    const unknownKey = error.keyword === "additionalProperties";
    const parent = dottedPath(error.instancePath);
    const extra = error.params["additionalProperty"];
    const path =
      unknownKey && typeof extra === "string" ? [parent, extra].filter(Boolean).join(".") : parent;
    const message = unknownKey ? "is not a known key" : (error.message ?? "is invalid");
    const messages = messagesByPath.get(path) ?? [];
    if (!messages.includes(message)) {
      messages.push(message);
    }
    messagesByPath.set(path, messages);
  }
  return [...messagesByPath].map(([path, messages]) => ({ path, message: messages.join(" or ") }));
}

function parseDocument(text: string, format: ConfigFormat, path: string): unknown {
  try {
    return format === "json" ? parseJsonc(text) : SmolToml.parse(text);
  } catch (error) {
    if (error instanceof JsoncSyntaxError) {
      throw new CliConfigIoError("parse_error", path, `Failed to parse ${path}: ${error.message}`);
    }
    if (error instanceof SmolToml.TomlError) {
      const reason = error.message.split("\n")[0];
      throw new CliConfigIoError(
        "parse_error",
        path,
        `Failed to parse ${path}: ${reason} (line ${error.line})`,
      );
    }
    throw error;
  }
}

function schemaRefOf(document: CliConfigDocument, text: string, format: ConfigFormat) {
  if (format === "json") {
    const ref = document[cliConfigSchemaKey];
    return typeof ref === "string" ? ref : undefined;
  }
  return SCHEMA_DIRECTIVE_LINE.exec(text)?.[1];
}

function existingSchemaRef(text: string, format: ConfigFormat, path: string): string | undefined {
  try {
    const existing = parseDocument(text, format, path);
    return isObject(existing) ? schemaRefOf(existing, text, format) : undefined;
  } catch {
    return undefined;
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const mode = await stat(filePath).then(
    (info) => info.mode & 0o7777,
    () => DEFAULT_FILE_MODE,
  );
  const tmpPath = `${filePath}.tmp.${Date.now()}.${randomBytes(3).toString("hex")}`;
  try {
    await writeFile(tmpPath, content, { mode });
    await rename(tmpPath, filePath);
  } finally {
    await rm(tmpPath, { force: true });
  }
}

/** Builds the effect-free facade; `loadSchema` supplies the published `CliConfig` JSON Schema. */
export function makeCliConfigPromiseIo(options: {
  readonly loadSchema: () => Promise<object>;
}): CliConfigPromiseIo {
  let validator: Promise<ValidateFunction> | undefined;

  function getValidator(): Promise<ValidateFunction> {
    validator ??= options
      .loadSchema()
      .then((schema) => new Ajv({ strict: false, allErrors: true }).compile(schema))
      .catch((error: unknown) => {
        validator = undefined;
        throw error;
      });
    return validator;
  }

  async function validateCliConfig(config: unknown) {
    const validate = await getValidator();
    return validate(config) ? [] : issuesFrom(validate.errors ?? []);
  }

  async function checked(config: unknown, path: string): Promise<CliConfigDocument> {
    const issues = isObject(config)
      ? await validateCliConfig(config)
      : [{ path: "", message: "must be a table of settings" }];
    if (!isObject(config) || issues.length > 0) {
      const detail = issues
        .map((issue) => (issue.path === "" ? issue.message : `${issue.path} ${issue.message}`))
        .join("; ");
      throw new CliConfigIoError(
        "invalid_config",
        path,
        `Invalid config ${path}: ${detail}`,
        issues,
      );
    }
    return config;
  }

  async function findConfigInRoot(root: string): Promise<CliProjectPaths | null> {
    const supabaseDir = join(root, "supabase");
    const jsonPath = join(supabaseDir, "config.json");
    const jsoncPath = join(supabaseDir, "config.jsonc");
    const tomlPath = join(supabaseDir, "config.toml");
    const [jsonExists, jsoncExists, tomlExists] = await Promise.all([
      exists(jsonPath),
      exists(jsoncPath),
      exists(tomlPath),
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

  async function findCliProjectPaths(
    cwd: string,
    findOptions?: Pick<LoadCliConfigDocumentOptions, "search">,
  ) {
    let current = resolve(cwd);
    if (findOptions?.search === false) {
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

  async function loadCliConfigFile(path: string): Promise<LoadedCliConfigDocument> {
    const format = formatForPath(path);
    const rawText = await readFile(path, "utf8");
    const config = await checked(parseDocument(rawText, format, path), path);
    const schemaRef = schemaRefOf(config, rawText, format);
    return {
      path,
      format,
      config,
      ...(schemaRef === undefined ? {} : { schemaRef }),
      ignoredPaths: [],
      rawText,
    };
  }

  async function loadCliConfig(cwd: string, loadOptions?: LoadCliConfigDocumentOptions) {
    const project = await findCliProjectPaths(cwd, loadOptions);
    if (project === null) {
      return null;
    }
    const jsonPath = join(project.supabaseDir, "config.json");
    const jsoncPath = join(project.supabaseDir, "config.jsonc");
    const tomlPath = join(project.supabaseDir, "config.toml");
    const tomlExists = await exists(tomlPath);

    let filePath: string | undefined;
    let ignoredPaths: string[] = [];
    if (loadOptions?.tomlOnly !== true) {
      const [jsonExists, jsoncExists] = await Promise.all([exists(jsonPath), exists(jsoncPath)]);
      if (jsonExists && jsoncExists) {
        throw new CliConfigIoError(
          "file_conflict",
          jsonPath,
          "Found both supabase/config.json and supabase/config.jsonc. Keep one and delete the other.",
        );
      }
      if (jsonExists || jsoncExists) {
        filePath = jsonExists ? jsonPath : jsoncPath;
        ignoredPaths = tomlExists ? [tomlPath] : [];
      }
    }
    if (filePath === undefined && tomlExists) {
      filePath = tomlPath;
    }
    if (filePath === undefined) {
      return null;
    }
    return { ...(await loadCliConfigFile(filePath)), ignoredPaths };
  }

  async function saveCliConfig(saveOptions: SaveCliConfigDocumentOptions) {
    const project = await findCliProjectPaths(saveOptions.cwd);
    const root = project?.projectRoot ?? resolve(saveOptions.cwd);
    const supabaseDir = join(root, "supabase");
    const jsonPath = join(supabaseDir, "config.json");
    const jsoncPath = join(supabaseDir, "config.jsonc");
    const tomlPath = join(supabaseDir, "config.toml");
    const [jsonExists, jsoncExists, tomlExists] = await Promise.all([
      exists(jsonPath),
      exists(jsoncPath),
      exists(tomlPath),
    ]);
    if (jsonExists && jsoncExists) {
      throw new CliConfigIoError(
        "file_conflict",
        jsonPath,
        "Found both supabase/config.json and supabase/config.jsonc. Keep one and delete the other.",
      );
    }

    const format: ConfigFormat =
      saveOptions.format ?? (jsonExists || jsoncExists || !tomlExists ? "json" : "toml");
    const filePath = format === "toml" ? tomlPath : jsoncExists ? jsoncPath : jsonPath;
    const config = await checked(saveOptions.config, filePath);

    const existingText = (await exists(filePath)) ? await readFile(filePath, "utf8") : undefined;
    const schemaRef =
      saveOptions.schemaRef ??
      (existingText === undefined ? undefined : existingSchemaRef(existingText, format, filePath));

    const body = Object.fromEntries(
      Object.entries(config).filter(([key]) => key !== cliConfigSchemaKey),
    );
    let content: string;
    if (format === "json") {
      const document =
        schemaRef === undefined ? body : { [cliConfigSchemaKey]: schemaRef, ...body };
      content = `${JSON.stringify(document, null, 2)}\n`;
      if (existingText !== undefined) {
        content = updateJsonDocument(existingText, parseJsonc(content)) ?? content;
      }
    } else {
      content = `${SmolToml.stringify(body)}\n`;
      if (schemaRef !== undefined) {
        content = `#:schema ${schemaRef}\n${content}`;
      }
    }

    await mkdir(supabaseDir, { recursive: true });
    await writeFileAtomic(filePath, content);
    for (const otherPath of [jsonPath, jsoncPath, tomlPath]) {
      if (otherPath !== filePath && (await exists(otherPath))) {
        await rm(otherPath);
      }
    }

    return {
      path: filePath,
      format,
      config,
      ...(schemaRef === undefined ? {} : { schemaRef }),
      ignoredPaths: [],
      rawText: content,
    };
  }

  return {
    findCliProjectPaths,
    findCliProjectRoot: async (cwd, findOptions) =>
      (await findCliProjectPaths(cwd, findOptions))?.projectRoot ?? null,
    loadCliConfig,
    loadCliConfigFile,
    validateCliConfig,
    saveCliConfig,
  };
}
