import type { CliConfig } from "@supabase/config";

import { dockerfileServiceImageRaw } from "../shared/services/dockerfile-images.ts";
import { serviceContainerIds } from "./docker-ids.ts";
import {
  envOverrideBool,
  resolveLocalConfigValues,
  type LocalConfigValues,
} from "./local-config-values.ts";

/**
 * A status output field: the dotted key `--override-name <key>=<name>` matches against
 * (`fieldKey`), and its default output env-var name (`defaultName`). Deprecated fields
 * (`inbucket`, `jwt_secret`, `anon_key`, `service_role_key`) are still emitted.
 */
export interface StatusField {
  readonly fieldKey: string;
  readonly defaultName: string;
}

const API_URL: StatusField = { fieldKey: "api.url", defaultName: "API_URL" };
const REST_URL: StatusField = { fieldKey: "api.rest_url", defaultName: "REST_URL" };
const GRAPHQL_URL: StatusField = { fieldKey: "api.graphql_url", defaultName: "GRAPHQL_URL" };
const STORAGE_S3_URL: StatusField = {
  fieldKey: "api.storage_s3_url",
  defaultName: "STORAGE_S3_URL",
};
const MCP_URL: StatusField = { fieldKey: "api.mcp_url", defaultName: "MCP_URL" };
const FUNCTIONS_URL: StatusField = {
  fieldKey: "api.functions_url",
  defaultName: "FUNCTIONS_URL",
};
const DB_URL: StatusField = { fieldKey: "db.url", defaultName: "DB_URL" };
const STUDIO_URL: StatusField = { fieldKey: "studio.url", defaultName: "STUDIO_URL" };
const INBUCKET_URL: StatusField = { fieldKey: "inbucket.url", defaultName: "INBUCKET_URL" };
const MAILPIT_URL: StatusField = { fieldKey: "mailpit.url", defaultName: "MAILPIT_URL" };
const PUBLISHABLE_KEY: StatusField = {
  fieldKey: "auth.publishable_key",
  defaultName: "PUBLISHABLE_KEY",
};
const SECRET_KEY: StatusField = { fieldKey: "auth.secret_key", defaultName: "SECRET_KEY" };
const JWT_SECRET: StatusField = { fieldKey: "auth.jwt_secret", defaultName: "JWT_SECRET" };
const ANON_KEY: StatusField = { fieldKey: "auth.anon_key", defaultName: "ANON_KEY" };
const SERVICE_ROLE_KEY: StatusField = {
  fieldKey: "auth.service_role_key",
  defaultName: "SERVICE_ROLE_KEY",
};
const STORAGE_S3_ACCESS_KEY_ID: StatusField = {
  fieldKey: "storage.s3_access_key_id",
  defaultName: "S3_PROTOCOL_ACCESS_KEY_ID",
};
const STORAGE_S3_SECRET_ACCESS_KEY: StatusField = {
  fieldKey: "storage.s3_secret_access_key",
  defaultName: "S3_PROTOCOL_ACCESS_KEY_SECRET",
};
const STORAGE_S3_REGION: StatusField = {
  fieldKey: "storage.s3_region",
  defaultName: "S3_PROTOCOL_REGION",
};

/** All 18 fields, in declaration order. */
export const STATUS_FIELDS: ReadonlyArray<StatusField> = [
  API_URL,
  REST_URL,
  GRAPHQL_URL,
  STORAGE_S3_URL,
  MCP_URL,
  FUNCTIONS_URL,
  DB_URL,
  STUDIO_URL,
  INBUCKET_URL,
  MAILPIT_URL,
  PUBLISHABLE_KEY,
  SECRET_KEY,
  JWT_SECRET,
  ANON_KEY,
  SERVICE_ROLE_KEY,
  STORAGE_S3_ACCESS_KEY_ID,
  STORAGE_S3_SECRET_ACCESS_KEY,
  STORAGE_S3_REGION,
];

/** The subset of {@link STATUS_FIELDS} the pretty renderer looks up by field. */
export interface StatusOutputNames {
  readonly apiUrl: string;
  readonly restUrl: string;
  readonly graphqlUrl: string;
  readonly storageS3Url: string;
  readonly mcpUrl: string;
  readonly functionsUrl: string;
  readonly dbUrl: string;
  readonly studioUrl: string;
  readonly mailpitUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly storageS3AccessKeyId: string;
  readonly storageS3SecretAccessKey: string;
  readonly storageS3Region: string;
}

/**
 * Resolves each field's output key, applying `--override-name <fieldKey>=<name>` remaps over
 * the default names. `overrides` maps `fieldKey` (e.g. `"api.url"`) to the replacement name.
 */
function resolveOutputNames(overrides: ReadonlyMap<string, string>): StatusOutputNames {
  const nameFor = (field: StatusField) => overrides.get(field.fieldKey) ?? field.defaultName;
  return {
    apiUrl: nameFor(API_URL),
    restUrl: nameFor(REST_URL),
    graphqlUrl: nameFor(GRAPHQL_URL),
    storageS3Url: nameFor(STORAGE_S3_URL),
    mcpUrl: nameFor(MCP_URL),
    functionsUrl: nameFor(FUNCTIONS_URL),
    dbUrl: nameFor(DB_URL),
    studioUrl: nameFor(STUDIO_URL),
    mailpitUrl: nameFor(MAILPIT_URL),
    publishableKey: nameFor(PUBLISHABLE_KEY),
    secretKey: nameFor(SECRET_KEY),
    storageS3AccessKeyId: nameFor(STORAGE_S3_ACCESS_KEY_ID),
    storageS3SecretAccessKey: nameFor(STORAGE_S3_SECRET_ACCESS_KEY),
    storageS3Region: nameFor(STORAGE_S3_REGION),
  };
}

/** Container ids each status group gates on, taken from `serviceContainerIds` (`docker-ids.ts`). */
export interface StatusContainerIds {
  readonly kong: string;
  readonly auth: string;
  readonly inbucket: string;
  readonly rest: string;
  readonly storage: string;
  readonly studio: string;
  readonly edgeRuntime: string;
}

// Positional indices into `serviceContainerIds`'s fixed array, named so a caller never has
// to destructure it positionally.
const CONTAINER_INDEX = {
  kong: 0,
  auth: 1,
  inbucket: 2,
  rest: 4,
  storage: 5,
  studio: 8,
  edgeRuntime: 9,
} as const;

/**
 * Derives {@link StatusContainerIds} from `serviceContainerIds`'s flat array for a given
 * project id, giving the handler a named-field view instead of positional destructuring.
 */
export function statusContainerIds(projectId: string): StatusContainerIds {
  const ids = serviceContainerIds(projectId);
  const at = (index: number) => ids[index] ?? "";
  return {
    kong: at(CONTAINER_INDEX.kong),
    auth: at(CONTAINER_INDEX.auth),
    inbucket: at(CONTAINER_INDEX.inbucket),
    rest: at(CONTAINER_INDEX.rest),
    storage: at(CONTAINER_INDEX.storage),
    studio: at(CONTAINER_INDEX.studio),
    edgeRuntime: at(CONTAINER_INDEX.edgeRuntime),
  };
}

/**
 * Extracts the repo name between the (first) `/` and the (last) `:`, falling back to the
 * full string when the image ref doesn't match (no slash, or no tag).
 */
export function shortContainerImageName(imageName: string): string {
  const match = /\/(.*):/.exec(imageName);
  return match?.[1] ?? imageName;
}

// Default image short names `--exclude` also matches against, one per gated service.
// Invariant to version pinning (`db-image.ts`'s `replaceImageTag` only rewrites the tag,
// which `shortContainerImageName` discards) and to `SUPABASE_USE_SLIM_IMAGES` (read from the
// raw manifest, since the established `--exclude` contract uses non-slim names).
const KONG_IMAGE_NAME = shortContainerImageName(dockerfileServiceImageRaw("kong"));
const POSTGREST_IMAGE_NAME = shortContainerImageName(dockerfileServiceImageRaw("postgrest"));
const STUDIO_IMAGE_NAME = shortContainerImageName(dockerfileServiceImageRaw("studio"));
const GOTRUE_IMAGE_NAME = shortContainerImageName(dockerfileServiceImageRaw("gotrue"));
const MAILPIT_IMAGE_NAME = shortContainerImageName(dockerfileServiceImageRaw("mailpit"));
const STORAGE_IMAGE_NAME = shortContainerImageName(dockerfileServiceImageRaw("storage"));
const EDGE_RUNTIME_IMAGE_NAME = shortContainerImageName(dockerfileServiceImageRaw("edgeruntime"));

export interface StatusValuesResult {
  readonly values: Record<string, string>;
  readonly names: StatusOutputNames;
  readonly local: LocalConfigValues;
}

/**
 * Everything needed to compute status output except `--override-name` remapping. Resolving
 * this once and reusing it for both the real values and the pretty-table values avoids
 * re-reading `auth.signing_keys_path` and re-signing the anon/service_role JWTs twice.
 */
export interface StatusState {
  readonly config: CliConfig;
  readonly local: LocalConfigValues;
  readonly kongEnabled: boolean;
  readonly postgrestEnabled: boolean;
  readonly studioEnabled: boolean;
  readonly authEnabled: boolean;
  readonly inbucketEnabled: boolean;
  readonly storageEnabled: boolean;
  readonly functionsEnabled: boolean;
  readonly storageS3ProtocolEnabled: boolean;
}

/**
 * The validating half of {@link StatusState}: everything that can throw, and none of it
 * depends on `excluded`/`containerIds`. Split out so `status.handler.ts` can resolve and
 * validate this before any Docker call — a bad `auth.jwt_secret` or malformed
 * `SUPABASE_*_PORT`/`SUPABASE_*_ENABLED` override must fail here, not be masked by a
 * Docker/DB error when the local stack happens to be unavailable.
 */
export interface StatusLocalState {
  readonly config: CliConfig;
  readonly local: LocalConfigValues;
  readonly apiEnabled: boolean;
  readonly studioSectionEnabled: boolean;
  readonly authSectionEnabled: boolean;
  readonly inbucketSectionEnabled: boolean;
  readonly storageSectionEnabled: boolean;
  readonly edgeRuntimeEnabled: boolean;
  readonly storageS3ProtocolEnabled: boolean;
}

/**
 * Resolves local config values (URLs, keys — can throw, see {@link resolveLocalConfigValues})
 * and the per-service `.enabled` gates, with no reference to `excluded`/`containerIds` — see
 * {@link gateStatusState} for the Docker-dependent half this composes with. Each `.enabled`
 * gate is read through {@link envOverrideBool}, not the raw decoded `config.<section>.enabled`,
 * so an env-overridden stack's running services match what `status` reports.
 *
 * @throws {InvalidJwtSecretError} when `auth.jwt_secret` is set but too short.
 * @throws {InvalidPortEnvOverrideError} when a `SUPABASE_*_PORT` env/dotenv override doesn't
 * parse as a valid port.
 * @throws {InvalidBoolEnvOverrideError} when a `SUPABASE_*_ENABLED` env/dotenv override
 * doesn't parse as a valid bool.
 * @throws when `auth.signing_keys_path` is set but the file is missing, malformed, or its
 * first key is unsupported — see {@link generateAsymmetricGoJwt}.
 */
export function resolveStatusLocalState(
  config: CliConfig,
  hostname: string,
  workdir: string,
  projectEnvValues?: Readonly<Record<string, string>>,
  /** `LoadedCliConfig.document` — see {@link resolveLocalConfigValues}'s doc comment. */
  document?: Readonly<Record<string, unknown>>,
  /**
   * An already-resolved {@link resolveLocalConfigValues} result to reuse instead of
   * re-deriving one. Callers that resolved `local` earlier in the same process (e.g.
   * `start`'s success-path status print) must pass it here: a second call re-mints a
   * time-dependent asymmetric JWT (`auth.signing_keys_path` + {@link generateAsymmetricGoJwt}'s
   * `exp` claim) with a different signature than the one baked into the already-running
   * containers.
   */
  precomputedLocal?: LocalConfigValues,
): StatusLocalState {
  const local =
    precomputedLocal ??
    resolveLocalConfigValues(config, hostname, workdir, projectEnvValues, document);

  const apiEnabled = envOverrideBool(
    "SUPABASE_API_ENABLED",
    config.api.enabled,
    "api.enabled",
    projectEnvValues,
  );
  const studioSectionEnabled = envOverrideBool(
    "SUPABASE_STUDIO_ENABLED",
    config.studio.enabled,
    "studio.enabled",
    projectEnvValues,
  );
  const authSectionEnabled = envOverrideBool(
    "SUPABASE_AUTH_ENABLED",
    config.auth.enabled,
    "auth.enabled",
    projectEnvValues,
  );
  const inbucketSectionEnabled = envOverrideBool(
    "SUPABASE_LOCAL_SMTP_ENABLED",
    config.local_smtp.enabled,
    "local_smtp.enabled",
    projectEnvValues,
  );
  const storageSectionEnabled = envOverrideBool(
    "SUPABASE_STORAGE_ENABLED",
    config.storage.enabled,
    "storage.enabled",
    projectEnvValues,
  );
  const edgeRuntimeEnabled = envOverrideBool(
    "SUPABASE_EDGE_RUNTIME_ENABLED",
    config.edge_runtime.enabled,
    "edge_runtime.enabled",
    projectEnvValues,
  );
  const storageS3ProtocolEnabled = envOverrideBool(
    "SUPABASE_STORAGE_S3_PROTOCOL_ENABLED",
    config.storage.s3_protocol.enabled,
    "storage.s3_protocol.enabled",
    projectEnvValues,
  );

  return {
    config,
    local,
    apiEnabled,
    studioSectionEnabled,
    authSectionEnabled,
    inbucketSectionEnabled,
    storageSectionEnabled,
    edgeRuntimeEnabled,
    storageS3ProtocolEnabled,
  };
}

/**
 * The Docker-dependent, non-throwing half of status resolution: applies `excluded`, matching
 * each gated service by its container id ({@link statusContainerIds}) or its default Docker
 * image short name ({@link shortContainerImageName}) — service images are never
 * user-overridable, so the default is always the one to check. Pure: every throwing concern
 * already ran in {@link resolveStatusLocalState}.
 */
export function gateStatusState(
  localState: StatusLocalState,
  containerIds: StatusContainerIds,
  excluded: ReadonlyArray<string>,
): StatusState {
  const { config, local } = localState;
  const { apiEnabled, studioSectionEnabled, authSectionEnabled } = localState;
  const { inbucketSectionEnabled, storageSectionEnabled } = localState;
  const { edgeRuntimeEnabled, storageS3ProtocolEnabled } = localState;
  const isExcluded = (id: string) => excluded.includes(id);

  const kongEnabled = apiEnabled && !isExcluded(containerIds.kong) && !isExcluded(KONG_IMAGE_NAME);
  const postgrestEnabled =
    kongEnabled && !isExcluded(containerIds.rest) && !isExcluded(POSTGREST_IMAGE_NAME);
  const studioEnabled =
    studioSectionEnabled && !isExcluded(containerIds.studio) && !isExcluded(STUDIO_IMAGE_NAME);
  const authEnabled =
    authSectionEnabled && !isExcluded(containerIds.auth) && !isExcluded(GOTRUE_IMAGE_NAME);
  const inbucketEnabled =
    inbucketSectionEnabled && !isExcluded(containerIds.inbucket) && !isExcluded(MAILPIT_IMAGE_NAME);
  const storageEnabled =
    storageSectionEnabled && !isExcluded(containerIds.storage) && !isExcluded(STORAGE_IMAGE_NAME);
  const functionsEnabled =
    edgeRuntimeEnabled &&
    !isExcluded(containerIds.edgeRuntime) &&
    !isExcluded(EDGE_RUNTIME_IMAGE_NAME);

  return {
    config,
    local,
    kongEnabled,
    postgrestEnabled,
    studioEnabled,
    authEnabled,
    inbucketEnabled,
    storageEnabled,
    functionsEnabled,
    storageS3ProtocolEnabled,
  };
}

/**
 * Applies `--override-name` remapping to an already-resolved {@link StatusState}. Pure and
 * non-throwing — every failure mode lives in {@link resolveStatusLocalState}.
 */
export function statusValuesFromState(
  state: StatusState,
  overrides: ReadonlyMap<string, string>,
): StatusValuesResult {
  const { local, kongEnabled, postgrestEnabled, studioEnabled, authEnabled } = state;
  const { inbucketEnabled, storageEnabled, functionsEnabled, storageS3ProtocolEnabled } = state;
  const names = resolveOutputNames(overrides);

  // `db.url` is always set unconditionally, before any gating.
  const values: Record<string, string> = {
    [names.dbUrl]: local.dbUrl,
  };

  if (kongEnabled) {
    values[names.apiUrl] = local.apiUrl;
    if (postgrestEnabled) {
      values[names.restUrl] = local.restUrl;
      values[names.graphqlUrl] = local.graphqlUrl;
    }
    if (functionsEnabled) {
      values[names.functionsUrl] = local.functionsUrl;
    }
    if (studioEnabled) {
      values[names.mcpUrl] = local.mcpUrl;
    }
  }
  if (studioEnabled) {
    values[names.studioUrl] = local.studioUrl;
  }
  if (authEnabled) {
    values[names.publishableKey] = local.publishableKey;
    values[names.secretKey] = local.secretKey;
    values[overrides.get(JWT_SECRET.fieldKey) ?? JWT_SECRET.defaultName] = local.jwtSecret;
    values[overrides.get(ANON_KEY.fieldKey) ?? ANON_KEY.defaultName] = local.anonKey;
    values[overrides.get(SERVICE_ROLE_KEY.fieldKey) ?? SERVICE_ROLE_KEY.defaultName] =
      local.serviceRoleKey;
  }
  if (inbucketEnabled) {
    values[names.mailpitUrl] = local.mailpitUrl;
    values[overrides.get(INBUCKET_URL.fieldKey) ?? INBUCKET_URL.defaultName] = local.mailpitUrl;
  }
  if (storageEnabled && storageS3ProtocolEnabled) {
    values[names.storageS3Url] = local.storageS3Url;
    values[names.storageS3AccessKeyId] = local.storageS3AccessKeyId;
    values[names.storageS3SecretAccessKey] = local.storageS3SecretAccessKey;
    values[names.storageS3Region] = local.storageS3Region;
  }

  return { values, names, local };
}

/**
 * Convenience wrapper combining {@link resolveStatusLocalState}, {@link gateStatusState}, and
 * {@link statusValuesFromState} in one call — used by tests needing only a single override
 * map. `status.handler.ts` calls the three separately so it can validate before any Docker
 * call and reuse the gated state for both the real and pretty-mode value maps.
 */
export function statusValues(
  config: CliConfig,
  containerIds: StatusContainerIds,
  hostname: string,
  excluded: ReadonlyArray<string>,
  overrides: ReadonlyMap<string, string>,
  workdir: string,
  projectEnvValues?: Readonly<Record<string, string>>,
  /** `LoadedCliConfig.document` — see {@link resolveLocalConfigValues}'s doc comment. */
  document?: Readonly<Record<string, unknown>>,
): StatusValuesResult {
  const localState = resolveStatusLocalState(config, hostname, workdir, projectEnvValues, document);
  const state = gateStatusState(localState, containerIds, excluded);
  return statusValuesFromState(state, overrides);
}
