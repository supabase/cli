import * as SmolToml from "smol-toml";
import { cliConfigSmtpIssues, type SmtpInput } from "./auth/email-rules.ts";
import {
  cliConfigExternalProviderIssues,
  type ExternalProviderInput,
} from "./auth/providers-rules.ts";
import { cliConfigSmsProviderIssues } from "./auth/sms-rules.ts";
import { toSparseConfigDocument } from "./config-encode-core.ts";
import type { ConfigFormat } from "./config-format.ts";
import { cliConfigMigrationChecksIssues } from "./db-migration-checks-rules.ts";
import {
  remotes as validateRemotes,
  root as validateRoot,
  schemaIndex,
} from "./generated/cli-config-validators.js";
import type { CompiledValidator } from "./generated/cli-config-validators.js";
import { JsoncSyntaxError, parseJsonc } from "./jsonc.ts";
import { cliConfigSchemaKey, isObject } from "./lib/document-value.ts";
import {
  interpolateEnvReferences,
  type EnvSchemaNavigator,
  type EnvWalkOptions,
} from "./lib/env-core.ts";
import { normalizeDeprecatedProviderSignupKeys } from "./lib/provider-signup.ts";
import { cliConfigServiceVersionIssues, memoryIssueMessage } from "./local-rules.ts";
import {
  CliConfigParseError,
  CliConfigRemovedKeyError,
  CliConfigSchemaVersionError,
  type CliConfigValidationIssue,
} from "./promise-errors.ts";
import {
  collectLeafPaths,
  mergeRemoteBlock,
  pathKey,
  remoteNameForProjectRef,
} from "./remotes-core.ts";
import { detectRemovedConfigKeys } from "./removed-config-keys-core.ts";
import { SUPPORTED_CLI_CONFIG_SCHEMA_VERSION } from "./schema-metadata.ts";
import { descendIndex, orderByIndex, type SchemaIndexNode } from "./schema-index-core.ts";
import {
  isSchemaTooNew,
  readCliConfigSchemaDeclaration,
  type CliConfigSchemaDeclaration,
} from "./schema-version.ts";

/** A config document as read from or written to disk; shape is enforced by the published JSON Schema. */
export type CliConfigDocument = { readonly [key: string]: unknown };

type CliConfigValueSource = "environment" | "local" | "remote";

interface CliConfigValueOrigin {
  readonly path: ReadonlyArray<string>;
  readonly source: CliConfigValueSource;
  readonly envVariables?: ReadonlyArray<string>;
}

export interface LoadedCliConfig {
  readonly path: string;
  readonly format: ConfigFormat;
  readonly config: CliConfigDocument;
  readonly schemaRef?: string;
  readonly ignoredPaths: ReadonlyArray<string>;
  /** Dotted paths of keys written with a deprecated spelling, e.g. `auth.email.enable_signup`. */
  readonly deprecatedPaths: ReadonlyArray<string>;
  /** The post-`env()` document `config` was decoded from, with any matching `[remotes.*]` override merged in. */
  readonly document?: Record<string, unknown>;
  /** The document as parsed from disk, before `env()` interpolation and the `[remotes.*]` merge. */
  readonly rawDocument?: Record<string, unknown>;
  /** The exact file text `rawDocument` and `config` were parsed from; absent from `saveCliConfig`. */
  readonly rawText?: string;
  /** The `env()`-interpolated `remotes` table, present whenever one exists. */
  readonly interpolatedRemotes?: Record<string, unknown>;
  /** The `[remotes.<name>]` block merged over the base config because its `project_id` matched `projectRef`. */
  readonly appliedRemote?: string;
  /** The source that supplied each explicitly configured effective leaf value. */
  readonly valueOrigins?: ReadonlyArray<CliConfigValueOrigin>;
}

const indexNavigator: EnvSchemaNavigator<SchemaIndexNode> = {
  child: descendIndex,
  expectedType: (node) => node.t ?? "unknown",
  isDeferred: (node) => node.d === true,
};

/** Substitutes `env(VAR)` references against `env` and coerces each value to the type its config key expects. */
export function interpolateCliConfigDocument(
  document: unknown,
  env: Readonly<Record<string, string>>,
  options?: EnvWalkOptions,
): unknown {
  return interpolateEnvReferences(document, env, indexNavigator, schemaIndex, options);
}

type AjvErrors = NonNullable<CompiledValidator["errors"]>;

function dottedPath(instancePath: string): string {
  return instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join(".");
}

function joinPath(...segments: ReadonlyArray<string>): string {
  return segments.filter((segment) => segment !== "").join(".");
}

function issuesFrom(prefix: string, errors: AjvErrors): ReadonlyArray<CliConfigValidationIssue> {
  const messagesByPath = new Map<string, Array<string>>();
  for (const error of errors) {
    if (error.keyword === "anyOf" || error.keyword === "oneOf") {
      continue;
    }
    const parent = joinPath(prefix, dottedPath(error.instancePath));
    const extra = error.params["additionalProperty"];
    const missing = error.params["missingProperty"];
    const [path, message] =
      error.keyword === "additionalProperties" && typeof extra === "string"
        ? [joinPath(parent, extra), "is not a known key"]
        : error.keyword === "required" && typeof missing === "string"
          ? [joinPath(parent, missing), "is required"]
          : [parent, error.message ?? "is invalid"];
    const messages = messagesByPath.get(path) ?? [];
    if (!messages.includes(message)) {
      messages.push(message);
    }
    messagesByPath.set(path, messages);
  }
  return [...messagesByPath].map(([path, messages]) => ({ path, message: messages.join(" or ") }));
}

function tableRuleIssues(
  prefix: string,
  issues: ReadonlyArray<{
    readonly path: ReadonlyArray<string | number>;
    readonly message: string;
  }>,
): ReadonlyArray<CliConfigValidationIssue> {
  return issues.map((issue) => ({
    path: joinPath(prefix, ...issue.path.map(String)),
    message: issue.message,
  }));
}

function childObject(
  value: unknown,
  ...keys: ReadonlyArray<string>
): Record<string, unknown> | undefined {
  let current = value;
  for (const key of keys) {
    current = isObject(current) ? current[key] : undefined;
  }
  return isObject(current) ? current : undefined;
}

// Validation has already checked every field; these guards only confirm the keys the rules read.
const isSmtpInput = (
  value: Record<string, unknown>,
): value is Record<string, unknown> & SmtpInput => typeof value["enabled"] === "boolean";

const isExternalProviderInput = (
  value: Record<string, unknown>,
): value is Record<string, unknown> & ExternalProviderInput =>
  typeof value["enabled"] === "boolean" && typeof value["client_id"] === "string";

type ServiceVersions = Parameters<typeof cliConfigServiceVersionIssues>[0];

const isServiceVersions = (value: Record<string, unknown>): value is ServiceVersions =>
  Object.values(value).every(
    (entry) =>
      entry === undefined ||
      (isObject(entry) && ["undefined", "string"].includes(typeof entry["version"])),
  );

function rootTableRuleIssues(
  config: Record<string, unknown>,
): ReadonlyArray<CliConfigValidationIssue> {
  const issues: Array<CliConfigValidationIssue> = [];
  const smtp = childObject(config, "auth", "email", "smtp");
  if (smtp !== undefined && isSmtpInput(smtp)) {
    issues.push(...tableRuleIssues("auth.email.smtp", cliConfigSmtpIssues(smtp)));
  }
  const sms = childObject(config, "auth", "sms");
  if (sms !== undefined) {
    issues.push(...tableRuleIssues("auth.sms", cliConfigSmsProviderIssues(sms)));
  }
  for (const [id, provider] of Object.entries(childObject(config, "auth", "external") ?? {})) {
    if (isObject(provider) && isExternalProviderInput(provider)) {
      issues.push(
        ...tableRuleIssues(`auth.external.${id}`, cliConfigExternalProviderIssues(id, provider)),
      );
    }
  }
  const services = childObject(config, "local", "services");
  if (services !== undefined && isServiceVersions(services)) {
    issues.push(
      ...tableRuleIssues("local.services", cliConfigServiceVersionIssues(services).slice(0, 1)),
    );
    for (const [name, entry] of Object.entries(services)) {
      const memory = childObject(entry, "container")?.["memory"];
      const message = typeof memory === "string" ? memoryIssueMessage(memory) : undefined;
      if (message !== undefined) {
        issues.push({ path: `local.services.${name}.container.memory`, message });
      }
    }
  }
  return issues;
}

function stringifyFileSizeLimit(table: Record<string, unknown> | undefined): void {
  if (table !== undefined && typeof table["file_size_limit"] === "number") {
    table["file_size_limit"] = String(table["file_size_limit"]);
  }
}

function dedupeExclusions(checks: Record<string, unknown> | undefined): void {
  const exclude = childObject(checks, "exclude");
  if (exclude === undefined) {
    return;
  }
  for (const [rule, entries] of Object.entries(exclude)) {
    if (Array.isArray(entries)) {
      exclude[rule] = [...new Set(entries)];
    }
  }
}

/** The value fix-ups decoding applies after validation: numeric size limits become strings and migration-check exclusions lose duplicates. */
function applyValueTransforms(layer: Record<string, unknown>): void {
  const storage = childObject(layer, "storage");
  stringifyFileSizeLimit(storage);
  for (const bucket of Object.values(childObject(storage, "buckets") ?? {})) {
    stringifyFileSizeLimit(isObject(bucket) ? bucket : undefined);
  }
  dedupeExclusions(childObject(layer, "db", "migrations", "checks"));
}

function runValidator(
  validator: CompiledValidator,
  prefix: string,
  data: unknown,
): ReadonlyArray<CliConfigValidationIssue> {
  return validator(data) ? [] : issuesFrom(prefix, validator.errors ?? []);
}

type CliConfigValidation =
  | { readonly ok: true; readonly config: Record<string, unknown> }
  | { readonly ok: false; readonly issues: ReadonlyArray<CliConfigValidationIssue> };

/**
 * Validates a complete config document with the same rules as the Effect loader: the base
 * document is fully checked, each `[remotes.*]` block structurally, and defaults are applied.
 */
function validateCliConfigDocument(
  value: unknown,
  options: { readonly applyTransforms: boolean } = { applyTransforms: true },
): CliConfigValidation {
  const folded = normalizeDeprecatedProviderSignupKeys(value).document;
  if (!isObject(folded)) {
    return { ok: false, issues: [{ path: "", message: "must be a table of settings" }] };
  }
  const { remotes: rawRemotes, ...rawRoot } = folded;
  const root = structuredClone(rawRoot);
  const rawChecks = childObject(rawRoot, "db", "migrations", "checks");
  const remotes: unknown = structuredClone(rawRemotes ?? {});

  const checkIssues =
    rawChecks === undefined
      ? []
      : tableRuleIssues("db.migrations.checks", cliConfigMigrationChecksIssues(rawChecks));
  const rootIssues = runValidator(validateRoot, "", root);
  const issues: Array<CliConfigValidationIssue> = [
    ...(checkIssues.length === 0
      ? rootIssues
      : rootIssues.filter((issue) => !issue.path.startsWith("db.migrations.checks"))),
    ...checkIssues,
    ...(rootIssues.length === 0 ? rootTableRuleIssues(root) : []),
    ...runValidator(validateRemotes, "remotes", remotes),
  ];
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  if (options.applyTransforms) {
    applyValueTransforms(root);
    if (isObject(remotes)) {
      for (const remote of Object.values(remotes)) {
        if (isObject(remote)) {
          applyValueTransforms(remote);
        }
      }
    }
  }
  const config = orderByIndex({ ...root, remotes }, schemaIndex);
  return isObject(config) ? { ok: true, config } : { ok: false, issues: [] };
}

let defaultConfig: Record<string, unknown> | undefined;

/** The config every key of which holds its schema default; the baseline `saveCliConfig` subtracts. */
export function defaultCliConfigDocument(): Record<string, unknown> {
  if (defaultConfig === undefined) {
    const result = validateCliConfigDocument({});
    if (!result.ok) {
      throw new Error("@supabase/config: the empty config document is invalid");
    }
    defaultConfig = result.config;
  }
  return defaultConfig;
}

function describeIssues(issues: ReadonlyArray<CliConfigValidationIssue>): string {
  return issues
    .map((issue) => (issue.path === "" ? issue.message : `${issue.path} ${issue.message}`))
    .join("; ");
}

function invalidConfigError(
  path: string,
  format: ConfigFormat,
  issues: ReadonlyArray<CliConfigValidationIssue>,
  appliedRemote: string | undefined,
): CliConfigParseError {
  return new CliConfigParseError({
    path,
    format,
    message: `Invalid config ${path}: ${describeIssues(issues)}`,
    issues,
    ...(appliedRemote === undefined ? {} : { appliedRemote }),
  });
}

/** Validates `document`, throwing a {@link CliConfigParseError} that lists every violation. */
function checkedCliConfig(
  document: unknown,
  path: string,
  format: ConfigFormat,
  appliedRemote?: string,
): Record<string, unknown> {
  const result = validateCliConfigDocument(document);
  if (!result.ok) {
    throw invalidConfigError(path, format, result.issues, appliedRemote);
  }
  return result.config;
}

/** Maps a config file path to its document format. */
export function formatForConfigPath(filePath: string): ConfigFormat {
  return filePath.endsWith(".json") || filePath.endsWith(".jsonc") ? "json" : "toml";
}

export function parseConfigText(text: string, format: ConfigFormat, path: string): unknown {
  try {
    return format === "json" ? parseJsonc(text) : SmolToml.parse(text);
  } catch (error) {
    if (error instanceof JsoncSyntaxError) {
      throw new CliConfigParseError({
        path,
        format,
        message: `Failed to parse ${path}: ${error.message}`,
        cause: error,
      });
    }
    if (error instanceof SmolToml.TomlError) {
      const reason = error.message.split("\n")[0];
      throw new CliConfigParseError({
        path,
        format,
        message: `Failed to parse ${path}: ${reason} (line ${error.line})`,
        cause: error,
      });
    }
    throw error;
  }
}

/** Throws a {@link CliConfigSchemaVersionError} when `declaration` names a newer schema than this package reads. */
export function failIfSchemaTooNew(
  path: string,
  format: ConfigFormat,
  declaration: CliConfigSchemaDeclaration | undefined,
): void {
  if (declaration?.version !== undefined && isSchemaTooNew(declaration)) {
    throw new CliConfigSchemaVersionError({
      path,
      format,
      schemaRef: declaration.ref,
      declaredVersion: declaration.version.toString(),
      supportedVersion: SUPPORTED_CLI_CONFIG_SCHEMA_VERSION,
    });
  }
}

/** The `$schema` key of a parsed document, when it is a string. */
export function schemaRefOfDocument(document: unknown): string | undefined {
  const schemaRef = isObject(document) ? document[cliConfigSchemaKey] : undefined;
  return typeof schemaRef === "string" ? schemaRef : undefined;
}

/** Parses `text` and rejects a newer schema version, without checking the document's keys. */
export function readConfigDocumentText(path: string, text: string) {
  const format = formatForConfigPath(path);
  failIfSchemaTooNew(path, format, readCliConfigSchemaDeclaration(text, format, undefined));
  const document = parseConfigText(text, format, path);
  failIfSchemaTooNew(path, format, readCliConfigSchemaDeclaration(text, format, document));
  return { format, document } as const;
}

/** Reads `text` and rejects removed keys, then folds deprecated provider-signup keys. */
export function readConfigText(path: string, text: string) {
  const { format, document } = readConfigDocumentText(path, text);
  if (isObject(document)) {
    const { removedKeys, document: stripped } = detectRemovedConfigKeys(document, false);
    if (removedKeys.length > 0) {
      throw new CliConfigRemovedKeyError({ path, format, removedKeys });
    }
    const { document: normalized, deprecatedPaths } =
      normalizeDeprecatedProviderSignupKeys(stripped);
    return { format, document, normalized, deprecatedPaths } as const;
  }
  return { format, document, normalized: document, deprecatedPaths: [] as Array<string> } as const;
}

/** Decodes config file `text` the way the Effect loader does: interpolate `env()`, merge the matching remote, validate. */
export function decodeParsedCliConfig(input: {
  readonly path: string;
  readonly text: string;
  readonly parsed: ReturnType<typeof readConfigText>;
  readonly env: Readonly<Record<string, string>>;
  readonly projectRef?: string;
}): LoadedCliConfig {
  const { path, text, env } = input;
  const { format, document, normalized, deprecatedPaths } = input.parsed;

  const interpolatedForRemotes = interpolateCliConfigDocument(normalized, env);
  const interpolatedRemotes =
    isObject(interpolatedForRemotes) && isObject(interpolatedForRemotes["remotes"])
      ? interpolatedForRemotes["remotes"]
      : undefined;

  const rawRemotes = isObject(normalized) ? normalized["remotes"] : undefined;
  const appliedRemote = isObject(rawRemotes)
    ? remoteNameForProjectRef(rawRemotes, input.projectRef)
    : undefined;
  const remoteSubtree =
    appliedRemote !== undefined && isObject(rawRemotes) ? rawRemotes[appliedRemote] : undefined;
  const remoteLeafPaths = appliedRemote === undefined ? [] : collectLeafPaths(remoteSubtree);
  const merged =
    isObject(normalized) && appliedRemote !== undefined
      ? mergeRemoteBlock(normalized, remoteSubtree)
      : normalized;

  const environmentPaths: Array<ReadonlyArray<string>> = [];
  const environmentNames = new Map<string, ReadonlyArray<string>>();
  const documentForDecode = isObject(merged)
    ? interpolateCliConfigDocument(merged, env, {
        onResolvedEnv: (resolvedPath, names) => {
          environmentPaths.push([...resolvedPath]);
          environmentNames.set(pathKey(resolvedPath), names);
        },
      })
    : merged;

  const config = checkedCliConfig(documentForDecode, path, format, appliedRemote);

  const localKeys = new Set(
    (isObject(normalized) ? collectLeafPaths(normalized) : []).map(pathKey),
  );
  const remoteKeys = new Set(remoteLeafPaths.map(pathKey));
  const environmentKeys = new Set(environmentPaths.map(pathKey));
  const valueOrigins = isObject(documentForDecode)
    ? collectLeafPaths(documentForDecode).flatMap((leaf): Array<CliConfigValueOrigin> => {
        const key = pathKey(leaf);
        const source: CliConfigValueSource | undefined = environmentKeys.has(key)
          ? "environment"
          : remoteKeys.has(key)
            ? "remote"
            : localKeys.has(key)
              ? "local"
              : undefined;
        if (source === undefined) {
          return [];
        }
        const envVariables = source === "environment" ? environmentNames.get(key) : undefined;
        return [{ path: leaf, source, ...(envVariables === undefined ? {} : { envVariables }) }];
      })
    : [];

  const schemaRef = schemaRefOfDocument(document);
  return {
    path,
    format,
    config,
    ...(schemaRef === undefined ? {} : { schemaRef }),
    ignoredPaths: [],
    deprecatedPaths,
    rawText: text,
    ...(isObject(documentForDecode) ? { document: documentForDecode } : {}),
    ...(isObject(normalized) ? { rawDocument: normalized } : {}),
    ...(interpolatedRemotes === undefined ? {} : { interpolatedRemotes }),
    ...(appliedRemote === undefined ? {} : { appliedRemote }),
    valueOrigins,
  };
}

/** The sparse config document as text: `config` minus the schema defaults, as JSON or TOML. */
export function encodeCliConfigText(
  config: CliConfigDocument,
  format: ConfigFormat,
  schemaRef: string | undefined,
  path: string,
): string {
  const result = validateCliConfigDocument(config, { applyTransforms: false });
  if (!result.ok) {
    throw invalidConfigError(path, format, result.issues, undefined);
  }
  const { remotes } = normalizeDeprecatedProviderSignupKeys(config).document;
  const encoded = { ...result.config, remotes: structuredClone(remotes ?? {}) };
  const document = toSparseConfigDocument(encoded, defaultCliConfigDocument(), schemaRef);
  const text = format === "json" ? JSON.stringify(document, null, 2) : SmolToml.stringify(document);
  return `${text}\n`;
}
