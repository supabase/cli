import type { ProjectConfig } from "@supabase/config";

import { dockerfileServiceImage } from "../../../shared/services/dockerfile-images.ts";
import { legacyServiceContainerIds } from "../../shared/legacy-docker-ids.ts";
import {
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
 * Port of Go's `(*CustomName).toValues(exclude...)` (`internal/status/status.go:50-97`).
 * `excluded` matches each gated service by its container id (`legacyStatusContainerIds`)
 * OR its default Docker image short name (`shortContainerImageName` above) — the 6
 * relevant Go config fields (`Api.KongImage`, `Api.Image`, `Studio.Image`, `Auth.Image`,
 * `Inbucket.Image`, `Storage.Image`, `EdgeRuntime.Image`) all carry `toml:"-"`, so they're
 * never user-overridable and the default image is always the one to check.
 */
export function legacyStatusValues(
  config: ProjectConfig,
  containerIds: LegacyStatusContainerIds,
  hostname: string,
  excluded: ReadonlyArray<string>,
  overrides: ReadonlyMap<string, string>,
): LegacyStatusValuesResult {
  const local = legacyResolveLocalConfigValues(config, hostname);
  const names = resolveOutputNames(overrides);
  const isExcluded = (id: string) => excluded.includes(id);

  const kongEnabled =
    config.api.enabled && !isExcluded(containerIds.kong) && !isExcluded(KONG_IMAGE_NAME);
  const postgrestEnabled =
    kongEnabled && !isExcluded(containerIds.rest) && !isExcluded(POSTGREST_IMAGE_NAME);
  const studioEnabled =
    config.studio.enabled && !isExcluded(containerIds.studio) && !isExcluded(STUDIO_IMAGE_NAME);
  const authEnabled =
    config.auth.enabled && !isExcluded(containerIds.auth) && !isExcluded(GOTRUE_IMAGE_NAME);
  const inbucketEnabled =
    config.local_smtp.enabled &&
    !isExcluded(containerIds.inbucket) &&
    !isExcluded(MAILPIT_IMAGE_NAME);
  const storageEnabled =
    config.storage.enabled && !isExcluded(containerIds.storage) && !isExcluded(STORAGE_IMAGE_NAME);
  const functionsEnabled =
    config.edge_runtime.enabled &&
    !isExcluded(containerIds.edgeRuntime) &&
    !isExcluded(EDGE_RUNTIME_IMAGE_NAME);

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
  if (storageEnabled && config.storage.s3_protocol.enabled) {
    values[names.storageS3Url] = local.storageS3Url;
    values[names.storageS3AccessKeyId] = local.storageS3AccessKeyId;
    values[names.storageS3SecretAccessKey] = local.storageS3SecretAccessKey;
    values[names.storageS3Region] = local.storageS3Region;
  }

  return { values, names, local };
}
