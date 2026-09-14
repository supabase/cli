import { Schema } from "effect";
import * as SmolToml from "smol-toml";
import { CliConfigSchema, type CliConfig } from "./base.ts";
import type { ConfigFormat } from "./config-format.ts";
import { getDefaultCliConfig, setOwnProperty, subtractValue } from "./sparse.ts";
import type { CliProjectEnvironment } from "./project.ts";

export const cliConfigSchemaKey = "$schema";

export type CliConfigValueSource = "environment" | "local" | "remote";

export interface CliConfigValueOrigin {
  readonly path: ReadonlyArray<string>;
  readonly source: CliConfigValueSource;
  /**
   * For `"environment"` origins: the env var names the `env()` reference
   * resolved from (one array literal may draw on several, so this is always
   * a list — consumers must never have to split a joined string).
   */
  readonly envVariables?: ReadonlyArray<string>;
}

export interface LoadedCliConfig {
  readonly path: string;
  readonly format: ConfigFormat;
  readonly config: CliConfig;
  readonly schemaRef?: string;
  readonly ignoredPaths: ReadonlyArray<string>;
  /**
   * The raw, post-`env()`-interpolation document `config` was decoded from, with any matching
   * `[remotes.*]` override merged in. Lets callers inspect key presence that the decoded
   * `config` loses (the schema defaults optional sections). Present whenever the file parsed to
   * an object.
   */
  readonly document?: Record<string, unknown>;
  /**
   * The raw document as parsed from disk: pre-`env()`-interpolation, pre-`[remotes.*]`-merge
   * (unlike {@link document}, whose `remotes` key has already been merged/stripped). Callers
   * matching a `[remotes.*]` block by its literal `project_id` must use this, not `document`.
   * Present whenever the file parsed to an object.
   */
  readonly rawDocument?: Record<string, unknown>;
  /**
   * The exact file text `rawDocument`/`config` were parsed from, present whenever the file was
   * read. Lets a caller that edits the file use this as its write-baseline instead of re-reading
   * it, so the plan it computed against can't diverge from the bytes it edits. `undefined` from
   * `saveCliConfig`, which regenerates content rather than parsing existing text.
   */
  readonly rawText?: string;
  /**
   * The already-`env()`-interpolated `remotes` subtree, letting a caller read a remote's
   * effective `project_id` without re-running interpolation itself. Present whenever a
   * `remotes` table exists, regardless of whether any block matched `projectRef`.
   */
  readonly interpolatedRemotes?: Record<string, unknown>;
  /**
   * Name of the `[remotes.<name>]` block whose subtree was merged over the base
   * config because its `project_id` matched the requested `projectRef`.
   * `undefined` when no `projectRef` was requested or none matched.
   */
  readonly appliedRemote?: string;
  /**
   * The `auth.external.{linkedin,slack}` sub-objects stripped from {@link document} before it
   * was returned, keyed by provider id (empty when neither was present). A caller scanning
   * `document` on its own may need to fold this back in, since `document` alone under-reports
   * what was originally there. Present whenever {@link document} is.
   */
  readonly removedDeprecatedExternalProviders?: Readonly<Record<string, unknown>>;
  /** The source that supplied each explicitly configured effective leaf value. */
  readonly valueOrigins?: ReadonlyArray<CliConfigValueOrigin>;
}

export const cliConfigValueSourceAt = (
  loaded: Pick<LoadedCliConfig, "valueOrigins">,
  path: ReadonlyArray<string>,
): CliConfigValueSource | undefined =>
  loaded.valueOrigins?.find(
    (origin) =>
      origin.path.length === path.length &&
      origin.path.every((segment, index) => segment === path[index]),
  )?.source;

/**
 * When `projectRef` is set, the matching `[remotes.<name>]` block is merged over the base
 * config before decode; omitting it loads the base config verbatim. Duplicate-`project_id` and
 * project-ref-format checks across every `[remotes.*]` block only run when
 * {@link InternalLoadCliConfigOptions.goViperCompat} is `true`, so callers that never opt into
 * that mode aren't broken by an unrelated malformed remote block.
 */
export interface LoadCliConfigOptions {
  readonly projectRef?: string;
  /**
   * Pre-resolved project environment used to interpolate `env()` references. When omitted,
   * it's resolved internally from `.env`/`.env.local` layered over `process.env`. Callers
   * needing environment-specific resolution can resolve it themselves and pass it in instead.
   */
  readonly cliProjectEnv?: CliProjectEnvironment;
  /** See {@link FindCliProjectPathsOptions.search}. */
  readonly search?: boolean;
  /** Skip the `config.json`-over-`config.toml` preference and only ever load `config.toml`. */
  readonly tomlOnly?: boolean;
}

/**
 * Not covered by semver — exported from `@supabase/config/internal` only. See
 * that module's header for why.
 */
export interface InternalLoadCliConfigOptions extends LoadCliConfigOptions {
  /**
   * Opts into Go/viper-parity decode and validation semantics: duplicate-`project_id` and
   * project-ref-format checks run across every `[remotes.*]` block even without a `projectRef`,
   * deprecated `auth.external.{linkedin,slack}` blocks warn on stderr, `env(...)` matching is
   * case-agnostic, and comma-separated strings coerce into `[]string`-typed fields regardless of
   * origin. Defaults to `false`, which `packages/stack` and the functions manifest rely on.
   */
  readonly goViperCompat?: boolean;
}

export interface SaveCliConfigOptions {
  readonly cwd: string;
  readonly config: CliConfig;
  readonly format?: ConfigFormat;
  readonly schemaRef?: string;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const encodeCliConfig = Schema.encodeSync(CliConfigSchema);

let defaultEncodedCliConfig: ReturnType<typeof encodeCliConfig> | undefined;

/** Memoized lazily, like `getDefaultCliConfig`, so importing the package doesn't pay for the encode. */
function getDefaultEncodedCliConfig(): ReturnType<typeof encodeCliConfig> {
  defaultEncodedCliConfig ??= encodeCliConfig(getDefaultCliConfig());
  return defaultEncodedCliConfig;
}

const defaultEncodedFunctionConfig = {
  enabled: true,
  verify_jwt: true,
  import_map: "",
  entrypoint: "",
  static_files: [],
  env: {},
};

function stripFunctionRecordDefaults(value: unknown): unknown {
  if (!isObject(value)) {
    return value;
  }

  const functionsValue = value.functions;
  if (!isObject(functionsValue)) {
    return value;
  }

  const functions: Record<string, unknown> = {};
  for (const [name, functionConfig] of Object.entries(functionsValue)) {
    setOwnProperty(
      functions,
      name,
      subtractValue(functionConfig, defaultEncodedFunctionConfig) ?? {},
    );
  }

  return { ...value, functions };
}

function encodeMinimalCliConfig(config: CliConfig): Record<string, unknown> {
  const encoded = stripFunctionRecordDefaults(encodeCliConfig(config));
  const stripped = subtractValue(encoded, getDefaultEncodedCliConfig());
  return isObject(stripped) ? stripped : {};
}

function toConfigDocument(
  config: CliConfig,
  schemaRef: string | undefined,
): Record<string, unknown> {
  const encoded = encodeMinimalCliConfig(config);
  return schemaRef === undefined ? encoded : { [cliConfigSchemaKey]: schemaRef, ...encoded };
}

export function encodeCliConfigToJson(config: CliConfig): string {
  return encodeCliConfigToJsonDocument(config, undefined);
}

export function encodeCliConfigToToml(config: CliConfig): string {
  return encodeCliConfigToTomlDocument(config, undefined);
}

export function encodeCliConfigToJsonDocument(
  config: CliConfig,
  schemaRef: string | undefined,
): string {
  return `${JSON.stringify(toConfigDocument(config, schemaRef), null, 2)}\n`;
}

export function encodeCliConfigToTomlDocument(
  config: CliConfig,
  schemaRef: string | undefined,
): string {
  return `${SmolToml.stringify(toConfigDocument(config, schemaRef))}\n`;
}
