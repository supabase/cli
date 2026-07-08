import type { ProjectConfig } from "@supabase/config";

import { dockerfileServiceImage } from "../../../shared/services/dockerfile-images.ts";
import { legacyServiceContainerIds } from "../../shared/legacy-docker-ids.ts";
import {
  legacyEnvOverrideBool,
  legacyResolveLocalConfigValues,
  type LegacyLocalConfigValues,
} from "../../shared/legacy-local-config-values.ts";

/**
 * Port of Go's `status.CustomName` + `toValues()` (`internal/status/status.go:29-97`).
 * Each field's Go `env:"..."` tag carries two things: the dotted key
 * `--override-name <key>=<name>` matches against (`fieldKey` below), and the
 * default output env-var name (`defaultName`). `deprecated` fields (`inbucket`,
 * `jwt_secret`, `anon_key`, `service_role_key`) are still emitted — Go's
 * `deprecated` tag only affects a startup warning it never wires up for `status`
 * (only `env.Unmarshal` reads the tag, and it does not warn), so no divergence here.
 */
export interface LegacyStatusField {
  readonly fieldKey: string;
  readonly defaultName: string;
}

const API_URL: LegacyStatusField = { fieldKey: "api.url", defaultName: "API_URL" };
const REST_URL: LegacyStatusField = { fieldKey: "api.rest_url", defaultName: "REST_URL" };
const GRAPHQL_URL: LegacyStatusField = { fieldKey: "api.graphql_url", defaultName: "GRAPHQL_URL" };
const STORAGE_S3_URL: LegacyStatusField = {
  fieldKey: "api.storage_s3_url",
  defaultName: "STORAGE_S3_URL",
};
const MCP_URL: LegacyStatusField = { fieldKey: "api.mcp_url", defaultName: "MCP_URL" };
const FUNCTIONS_URL: LegacyStatusField = {
  fieldKey: "api.functions_url",
  defaultName: "FUNCTIONS_URL",
};
const DB_URL: LegacyStatusField = { fieldKey: "db.url", defaultName: "DB_URL" };
const STUDIO_URL: LegacyStatusField = { fieldKey: "studio.url", defaultName: "STUDIO_URL" };
const INBUCKET_URL: LegacyStatusField = { fieldKey: "inbucket.url", defaultName: "INBUCKET_URL" };
const MAILPIT_URL: LegacyStatusField = { fieldKey: "mailpit.url", defaultName: "MAILPIT_URL" };
const PUBLISHABLE_KEY: LegacyStatusField = {
  fieldKey: "auth.publishable_key",
  defaultName: "PUBLISHABLE_KEY",
};
const SECRET_KEY: LegacyStatusField = { fieldKey: "auth.secret_key", defaultName: "SECRET_KEY" };
const JWT_SECRET: LegacyStatusField = { fieldKey: "auth.jwt_secret", defaultName: "JWT_SECRET" };
const ANON_KEY: LegacyStatusField = { fieldKey: "auth.anon_key", defaultName: "ANON_KEY" };
const SERVICE_ROLE_KEY: LegacyStatusField = {
  fieldKey: "auth.service_role_key",
  defaultName: "SERVICE_ROLE_KEY",
};
const STORAGE_S3_ACCESS_KEY_ID: LegacyStatusField = {
  fieldKey: "storage.s3_access_key_id",
  defaultName: "S3_PROTOCOL_ACCESS_KEY_ID",
};
const STORAGE_S3_SECRET_ACCESS_KEY: LegacyStatusField = {
  fieldKey: "storage.s3_secret_access_key",
  defaultName: "S3_PROTOCOL_ACCESS_KEY_SECRET",
};
const STORAGE_S3_REGION: LegacyStatusField = {
  fieldKey: "storage.s3_region",
  defaultName: "S3_PROTOCOL_REGION",
};

/** All 18 fields, in `CustomName` struct declaration order. */
export const LEGACY_STATUS_FIELDS: ReadonlyArray<LegacyStatusField> = [
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

/** The subset of {@link LEGACY_STATUS_FIELDS} the pretty renderer looks up by field. */
export interface LegacyStatusOutputNames {
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
 * Resolves each field's output KEY, applying `--override-name <fieldKey>=<name>`
 * remaps over the Go default names. `overrides` maps `fieldKey` (e.g. `"api.url"`)
 * to the replacement output name, mirroring `env.Unmarshal`'s `default=` override.
 */
function resolveOutputNames(overrides: ReadonlyMap<string, string>): LegacyStatusOutputNames {
  const nameFor = (field: LegacyStatusField) => overrides.get(field.fieldKey) ?? field.defaultName;
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

/**
 * Container ids `toValues()` gates each group on, taken from
 * `legacyServiceContainerIds`'s alias order (`kong`, `auth`, `inbucket`, ...,
 * `edge_runtime`, ...) — see `legacy-docker-ids.ts`.
 */
export interface LegacyStatusContainerIds {
  readonly kong: string;
  readonly auth: string;
  readonly inbucket: string;
  readonly rest: string;
  readonly storage: string;
  readonly studio: string;
  readonly edgeRuntime: string;
}

// Positional indices into `legacyServiceContainerIds`'s fixed 13-element
// array (`legacy-docker-ids.ts`'s `GetDockerIds()` order), named so a caller
// never has to destructure the array positionally.
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
 * Derives {@link LegacyStatusContainerIds} from `legacyServiceContainerIds`'s
 * flat array for a given project id. The array's length and order are a fixed
 * Go-parity contract (13 elements, `GetDockerIds()` order), so every named
 * index here is guaranteed present — this only exists to give the handler a
 * named-field view instead of positional array destructuring.
 */
export function legacyStatusContainerIds(projectId: string): LegacyStatusContainerIds {
  const ids = legacyServiceContainerIds(projectId);
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
 * Port of Go's `utils.ShortContainerImageName` (`internal/utils/misc.go:33-39,75`):
 * extracts the repo name between the (first) `/` and the (last) `:`, falling back to
 * the full string when the image ref doesn't match (no slash, or no tag).
 */
export function legacyShortContainerImageName(imageName: string): string {
  const match = /\/(.*):/.exec(imageName);
  return match?.[1] ?? imageName;
}

// Default image short names Go's `--exclude` also matches against
// (`internal/status/status.go:55-61`), one per gated service. Sourced from the same
// embedded Dockerfile manifest Go parses (`dockerfileServiceImage`), so a version bump
// there is picked up automatically. Pinned-version substitution
// (`legacy-db-image.ts`'s `replaceImageTag`) only ever rewrites the portion after the
// first `:`, which `legacyShortContainerImageName` discards — so these are invariant to
// version pinning and no `.temp/<service>-version` file needs to be read here.
const KONG_IMAGE_NAME = legacyShortContainerImageName(dockerfileServiceImage("kong"));
const POSTGREST_IMAGE_NAME = legacyShortContainerImageName(dockerfileServiceImage("postgrest"));
const STUDIO_IMAGE_NAME = legacyShortContainerImageName(dockerfileServiceImage("studio"));
const GOTRUE_IMAGE_NAME = legacyShortContainerImageName(dockerfileServiceImage("gotrue"));
const MAILPIT_IMAGE_NAME = legacyShortContainerImageName(dockerfileServiceImage("mailpit"));
const STORAGE_IMAGE_NAME = legacyShortContainerImageName(dockerfileServiceImage("storage"));
const EDGE_RUNTIME_IMAGE_NAME = legacyShortContainerImageName(
  dockerfileServiceImage("edgeruntime"),
);

export interface LegacyStatusValuesResult {
  readonly values: Record<string, string>;
  readonly names: LegacyStatusOutputNames;
  readonly local: LegacyLocalConfigValues;
}

/**
 * Everything `toValues()` needs that does NOT depend on `--override-name` —
 * i.e. every field except the output KEY remapping. Resolving this once and
 * reusing it for both the env/json/toml/yaml values (real overrides) and the
 * pretty-table values (Go always recomputes with an empty override map,
 * `status.go:236-243`) avoids re-reading `auth.signing_keys_path` and
 * re-signing the anon/service_role JWTs a second time per invocation.
 */
export interface LegacyStatusState {
  readonly config: ProjectConfig;
  readonly local: LegacyLocalConfigValues;
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
 * The config-load/`Validate`-equivalent half of {@link LegacyStatusState} —
 * everything that can THROW, and none of it depends on `excluded`/
 * `containerIds`. Split out so `status.handler.ts` can resolve and validate
 * this before any Docker call, matching Go's `flags.LoadConfig` (config load
 * + `Validate`, `internal/utils/flags/config_path.go:12` ->
 * `pkg/config/config.go:882`) running entirely before `assertContainerHealthy`/
 * container listing (`internal/status/status.go:101-116`) — a bad
 * `auth.jwt_secret` or malformed `SUPABASE_*_PORT`/`SUPABASE_*_ENABLED`
 * override must fail here, not be masked by a Docker/DB error when the local
 * stack happens to be unavailable.
 */
export interface LegacyStatusLocalState {
  readonly config: ProjectConfig;
  readonly local: LegacyLocalConfigValues;
  readonly apiEnabled: boolean;
  readonly studioSectionEnabled: boolean;
  readonly authSectionEnabled: boolean;
  readonly inbucketSectionEnabled: boolean;
  readonly storageSectionEnabled: boolean;
  readonly edgeRuntimeEnabled: boolean;
  readonly storageS3ProtocolEnabled: boolean;
}

/**
 * Port of the throwing, non-Docker-dependent half of Go's
 * `(*CustomName).toValues(exclude...)` (`internal/status/status.go:50-97`):
 * resolves local config values (URLs, keys — can throw, see
 * {@link legacyResolveLocalConfigValues}) and the per-service `.enabled` gates,
 * with NO reference to `excluded`/`containerIds` — see {@link legacyGateStatusState}
 * for the Docker-dependent, non-throwing half this composes with (in
 * `status.handler.ts`, or via {@link legacyStatusValues} for callers that
 * don't need to run validation before Docker calls).
 *
 * Each `.enabled` gate is read through {@link legacyEnvOverrideBool}, not the
 * raw decoded `config.<section>.enabled`, because Go's `status.toValues()`
 * (`status.go:55-61`) reads `utils.Config.*.Enabled` — a package-level struct
 * Viper has already applied any `SUPABASE_<SECTION>_ENABLED` env/dotenv
 * override to (`SetEnvPrefix("SUPABASE")` + `AutomaticEnv()` +
 * `ExperimentalBindStruct()`, `pkg/config/config.go:580-586`) — generically,
 * not just for `auth.enabled`. Skipping this would mean a stack Go started
 * with e.g. `SUPABASE_API_ENABLED=true` over a `false` TOML value has Kong/
 * PostgREST running while native `status` omits them entirely.
 *
 * @throws {LegacyInvalidJwtSecretError} when `auth.jwt_secret` is set but too short.
 * @throws {LegacyInvalidPortEnvOverrideError} when a `SUPABASE_*_PORT` env/dotenv
 * override doesn't parse as a valid port.
 * @throws {LegacyInvalidBoolEnvOverrideError} when a `SUPABASE_*_ENABLED` env/dotenv
 * override doesn't parse as a valid bool.
 * @throws when `auth.signing_keys_path` is set but the file is missing, malformed,
 * or its first key is unsupported — see {@link legacyGenerateAsymmetricGoJwt}.
 */
export function legacyResolveStatusLocalState(
  config: ProjectConfig,
  hostname: string,
  workdir: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined = undefined,
  /** `LoadedProjectConfig.document` — see {@link legacyResolveLocalConfigValues}'s doc comment. */
  document: Readonly<Record<string, unknown>> | undefined = undefined,
): LegacyStatusLocalState {
  const local = legacyResolveLocalConfigValues(
    config,
    hostname,
    workdir,
    projectEnvValues,
    document,
  );

  const apiEnabled = legacyEnvOverrideBool(
    "SUPABASE_API_ENABLED",
    config.api.enabled,
    "api.enabled",
    projectEnvValues,
  );
  const studioSectionEnabled = legacyEnvOverrideBool(
    "SUPABASE_STUDIO_ENABLED",
    config.studio.enabled,
    "studio.enabled",
    projectEnvValues,
  );
  const authSectionEnabled = legacyEnvOverrideBool(
    "SUPABASE_AUTH_ENABLED",
    config.auth.enabled,
    "auth.enabled",
    projectEnvValues,
  );
  const inbucketSectionEnabled = legacyEnvOverrideBool(
    "SUPABASE_LOCAL_SMTP_ENABLED",
    config.local_smtp.enabled,
    "local_smtp.enabled",
    projectEnvValues,
  );
  const storageSectionEnabled = legacyEnvOverrideBool(
    "SUPABASE_STORAGE_ENABLED",
    config.storage.enabled,
    "storage.enabled",
    projectEnvValues,
  );
  const edgeRuntimeEnabled = legacyEnvOverrideBool(
    "SUPABASE_EDGE_RUNTIME_ENABLED",
    config.edge_runtime.enabled,
    "edge_runtime.enabled",
    projectEnvValues,
  );
  const storageS3ProtocolEnabled = legacyEnvOverrideBool(
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
 * The Docker-dependent, non-throwing half of Go's `toValues()`: applies
 * `excluded` (matching each gated service by its container id
 * (`legacyStatusContainerIds`) OR its default Docker image short name
 * (`legacyShortContainerImageName` above) — the 6 relevant Go config fields
 * (`Api.KongImage`, `Api.Image`, `Studio.Image`, `Auth.Image`, `Inbucket.Image`,
 * `Storage.Image`, `EdgeRuntime.Image`) all carry `toml:"-"`, so they're never
 * user-overridable and the default image is always the one to check) on top of
 * an already-resolved {@link LegacyStatusLocalState}. Pure: every throwing
 * concern already ran in {@link legacyResolveStatusLocalState}.
 */
export function legacyGateStatusState(
  localState: LegacyStatusLocalState,
  containerIds: LegacyStatusContainerIds,
  excluded: ReadonlyArray<string>,
): LegacyStatusState {
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
 * Applies `--override-name` remapping to an already-resolved {@link LegacyStatusState}.
 * Pure and non-throwing — every failure mode of `toValues()` lives in
 * {@link legacyResolveStatusLocalState}, which runs once per `status` invocation.
 */
export function legacyStatusValuesFromState(
  state: LegacyStatusState,
  overrides: ReadonlyMap<string, string>,
): LegacyStatusValuesResult {
  const { local, kongEnabled, postgrestEnabled, studioEnabled, authEnabled } = state;
  const { inbucketEnabled, storageEnabled, functionsEnabled, storageS3ProtocolEnabled } = state;
  const names = resolveOutputNames(overrides);

  // Go always sets db.url unconditionally, before any gating (status.go:52).
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
 * Convenience wrapper combining {@link legacyResolveStatusLocalState} +
 * {@link legacyGateStatusState} + {@link legacyStatusValuesFromState} in one
 * call — used directly by tests that only need a single override map.
 * `status.handler.ts` calls the three separately instead, so it can resolve +
 * validate `localState` before any Docker call (see
 * {@link legacyResolveStatusLocalState}'s doc comment), and reuse the gated
 * `state` for both the real and pretty-mode (empty-override) value maps
 * without recomputing `local`.
 */
export function legacyStatusValues(
  config: ProjectConfig,
  containerIds: LegacyStatusContainerIds,
  hostname: string,
  excluded: ReadonlyArray<string>,
  overrides: ReadonlyMap<string, string>,
  workdir: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined = undefined,
  /** `LoadedProjectConfig.document` — see {@link legacyResolveLocalConfigValues}'s doc comment. */
  document: Readonly<Record<string, unknown>> | undefined = undefined,
): LegacyStatusValuesResult {
  const localState = legacyResolveStatusLocalState(
    config,
    hostname,
    workdir,
    projectEnvValues,
    document,
  );
  const state = legacyGateStatusState(localState, containerIds, excluded);
  return legacyStatusValuesFromState(state, overrides);
}
