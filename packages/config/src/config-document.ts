import { Schema } from "effect";
import * as SmolToml from "smol-toml";
import { ProjectConfigSchema, type ProjectConfig } from "./base.ts";
import { getDefaultProjectConfig, setOwnProperty, subtractValue } from "./sparse.ts";
import type { ProjectEnvironment } from "./project.ts";

/** Shared with `io.ts`'s `getSchemaRef`, which reads this key back off a raw document. */
export const projectConfigSchemaKey = "$schema";

export type ConfigFormat = "json" | "toml";

export type ProjectConfigValueSource = "environment" | "local" | "remote";

export interface ProjectConfigValueOrigin {
  readonly path: ReadonlyArray<string>;
  readonly source: ProjectConfigValueSource;
}

export interface LoadedProjectConfig {
  readonly path: string;
  readonly format: ConfigFormat;
  readonly config: ProjectConfig;
  readonly schemaRef?: string;
  readonly ignoredPaths: ReadonlyArray<string>;
  /**
   * The raw, post-`env()`-interpolation document the `config` was decoded from,
   * with any matching `[remotes.*]` override already merged in (see
   * {@link LoadProjectConfigOptions.projectRef}). Lets callers inspect key
   * presence — which the decoded `config` loses because the schema defaults
   * optional sections — without re-reading the file. Present whenever the file
   * parsed to an object.
   */
  readonly document?: Record<string, unknown>;
  /**
   * Name of the `[remotes.<name>]` block whose subtree was merged over the base
   * config because its `project_id` matched the requested `projectRef`.
   * `undefined` when no `projectRef` was requested or none matched.
   */
  readonly appliedRemote?: string;
  /**
   * The top-level `auth.external.{linkedin,slack}` sub-objects that were stripped from
   * {@link document} before it was returned (provider id → the removed object), keyed by
   * provider id. Empty when neither deprecated block was present. See
   * `normalizeDeprecatedExternalProviders`'s doc comment for why a caller doing its own
   * Go-parity scan over `document` (e.g. a decrypt-or-abort secret check) may need to fold
   * this back in — Go's decode-time decrypt hook sees these blocks before its later
   * validate-time deletion, so `document` alone under-reports what Go would have decrypted.
   * Present (possibly `{}`) whenever {@link document} is; absent from `saveProjectConfig`'s
   * result, which has no document to strip from.
   */
  readonly removedDeprecatedExternalProviders?: Readonly<Record<string, unknown>>;
  /** The source that supplied each explicitly configured effective leaf value. */
  readonly valueOrigins?: ReadonlyArray<ProjectConfigValueOrigin>;
}

export const projectConfigValueSourceAt = (
  loaded: Pick<LoadedProjectConfig, "valueOrigins">,
  path: ReadonlyArray<string>,
): ProjectConfigValueSource | undefined =>
  loaded.valueOrigins?.find(
    (origin) =>
      origin.path.length === path.length &&
      origin.path.every((segment, index) => segment === path[index]),
  )?.source;

/**
 * When `projectRef` is set, the matching `[remotes.<name>]` block (the one
 * whose `project_id` equals it) is merged over the base config before decode,
 * mirroring Go's `config.Load` with `Config.ProjectId` set
 * (`apps/cli-go/pkg/config/config.go:503-562`). Omitting it loads the base
 * config verbatim (no merge), so existing callers are unaffected. Go's
 * duplicate-`project_id`/project-ref-format checks across every
 * `[remotes.*]` block (`config.go:594-602,996-1001`) run unconditionally on
 * every config load in Go, not only when a caller ends up selecting a
 * remote — but here they only run when {@link LoadProjectConfigOptions.goViperCompat}
 * is `true`, regardless of whether `projectRef` is set, so non-Go-parity
 * callers that never select a remote (and never opt into Go parity) aren't
 * broken by an unrelated duplicate/malformed `[remotes.*]` block.
 */
export interface LoadProjectConfigOptions {
  readonly projectRef?: string;
  /**
   * Pre-resolved project environment used to interpolate `env()` references.
   * When omitted, the environment is resolved internally from `.env`/`.env.local`
   * layered over `process.env` (the default for most callers). Callers that need
   * Go-accurate, environment-specific resolution (e.g. `functions serve`, which
   * also reads `.env.<SUPABASE_ENV>` files) resolve it themselves and pass it in
   * so loading does not re-read those files or depend on `process.env` mutation.
   */
  readonly projectEnv?: ProjectEnvironment;
  /** See {@link FindProjectPathsOptions.search}. */
  readonly search?: boolean;
  /**
   * Skip the `config.json`-over-`config.toml` preference below and only ever
   * load `config.toml`. Go's `Config.Load`/`NewPathBuilder`
   * (`apps/cli-go/pkg/config/utils.go:43-48`) has no concept of a JSON project
   * config file — it always resolves `supabase/config.toml` and treats a
   * missing file as defaults — so Go-parity callers (the legacy `status`/`stop`
   * ports) must set this to avoid picking up a stray `config.json` that Go
   * would never see.
   */
  readonly tomlOnly?: boolean;
  /**
   * Opt into the Go/viper-parity decode+validation semantics this loader
   * otherwise omits, so only the Go-parity legacy shell (and shared modules
   * invoked exclusively by it) pays for them. Defaults to `false` = pre-PR-#5765
   * behavior, which `next/`, `packages/stack`, and the functions manifest rely
   * on. When `true`, mirrors Go's `config.Load` exactly:
   *  - runs the unconditional duplicate-`project_id` and project-ref-format
   *    checks across every `[remotes.*]` block (`config.go:594-602,996-1001`),
   *    even when no `projectRef` is requested;
   *  - warns on stderr for deprecated `auth.external.{linkedin,slack}` blocks
   *    (`config.go:1418-1423`) — the block is stripped from the decoded config
   *    either way, since the schema ignores excess properties;
   *  - matches `env(...)` references case-agnostically (`^env\((.*)\)$`)
   *    rather than the strict SCREAMING_SNAKE_CASE form;
   *  - splits a comma-separated string into a `[]string`-typed field (Go's
   *    `mapstructure.StringToSliceHookFunc(",")`, `config.go:775-784`), not
   *    just an `env()`-substituted one.
   */
  readonly goViperCompat?: boolean;
}

export interface SaveProjectConfigOptions {
  readonly cwd: string;
  readonly config: ProjectConfig;
  readonly format?: ConfigFormat;
  readonly schemaRef?: string;
}

/**
 * Shared with `io.ts`, which uses it to inspect raw (pre-decode) config
 * documents while resolving `[remotes.*]` overrides and stripping deprecated
 * sections.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const encodeProjectConfig = Schema.encodeSync(ProjectConfigSchema);

let defaultEncodedProjectConfig: ReturnType<typeof encodeProjectConfig> | undefined;

/**
 * Memoized like `getDefaultProjectConfig` — only the save path needs the
 * encoded defaults, so importing the package pays for no schema decode.
 */
function getDefaultEncodedProjectConfig(): ReturnType<typeof encodeProjectConfig> {
  defaultEncodedProjectConfig ??= encodeProjectConfig(getDefaultProjectConfig());
  return defaultEncodedProjectConfig;
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

function encodeMinimalProjectConfig(config: ProjectConfig): Record<string, unknown> {
  const encoded = stripFunctionRecordDefaults(encodeProjectConfig(config));
  const stripped = subtractValue(encoded, getDefaultEncodedProjectConfig());
  return isObject(stripped) ? stripped : {};
}

function toConfigDocument(
  config: ProjectConfig,
  schemaRef: string | undefined,
): Record<string, unknown> {
  const encoded = encodeMinimalProjectConfig(config);
  return schemaRef === undefined ? encoded : { [projectConfigSchemaKey]: schemaRef, ...encoded };
}

export function encodeProjectConfigToJson(config: ProjectConfig): string {
  return encodeProjectConfigToJsonDocument(config, undefined);
}

export function encodeProjectConfigToToml(config: ProjectConfig): string {
  return encodeProjectConfigToTomlDocument(config, undefined);
}

/** Shared with `io.ts`'s `saveProjectConfig`, which needs the `schemaRef`-carrying variant. */
export function encodeProjectConfigToJsonDocument(
  config: ProjectConfig,
  schemaRef: string | undefined,
): string {
  return `${JSON.stringify(toConfigDocument(config, schemaRef), null, 2)}\n`;
}

/** Shared with `io.ts`'s `saveProjectConfig`, which needs the `schemaRef`-carrying variant. */
export function encodeProjectConfigToTomlDocument(
  config: ProjectConfig,
  schemaRef: string | undefined,
): string {
  return `${SmolToml.stringify(toConfigDocument(config, schemaRef))}\n`;
}
