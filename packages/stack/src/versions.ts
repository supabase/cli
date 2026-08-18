import {
  DEFAULT_VERSIONS,
  SERVICE_NAMES,
  dockerImageCandidatesForArtifact,
  dockerImageForArtifact,
  imageTagPrefixForService,
} from "./ServiceCatalog.ts";
import type { ServiceName } from "./ServiceName.ts";

export { DEFAULT_VERSIONS, SERVICE_NAMES } from "./ServiceCatalog.ts";
export type { ServiceName } from "./ServiceName.ts";

export type VersionManifest = Readonly<Record<ServiceName, string>>;

export const PartialVersionManifestSchema = Schema.Struct({
  postgres: Schema.optionalKey(Schema.String),
  postgrest: Schema.optionalKey(Schema.String),
  auth: Schema.optionalKey(Schema.String),
  "edge-runtime": Schema.optionalKey(Schema.String),
  realtime: Schema.optionalKey(Schema.String),
  storage: Schema.optionalKey(Schema.String),
  imgproxy: Schema.optionalKey(Schema.String),
  mailpit: Schema.optionalKey(Schema.String),
  pgmeta: Schema.optionalKey(Schema.String),
  studio: Schema.optionalKey(Schema.String),
  analytics: Schema.optionalKey(Schema.String),
  vector: Schema.optionalKey(Schema.String),
  pooler: Schema.optionalKey(Schema.String),
});

export type PartialVersionManifest = Schema.Schema.Type<typeof PartialVersionManifestSchema>;

export const IMAGE_TAG_PREFIX: Partial<Record<ServiceName, string>> = Object.fromEntries(
  SERVICE_NAMES.flatMap((service) => {
    const prefix = imageTagPrefixForService(service);
    return prefix === undefined ? [] : [[service, prefix]];
  }),
);

/**
 * Returns the full Docker image URL for a service.
 *
 * Uses the same registry resolution as the Go CLI: images are pulled from
 * `public.ecr.aws/supabase/` by default (faster than Docker Hub).
 */
export function dockerImageForService(service: ServiceName, version: string): string {
  return dockerImageForArtifact(service, version);
}

export function dockerImageCandidatesForService(
  service: ServiceName,
  version: string,
): ReadonlyArray<string> {
  return dockerImageCandidatesForArtifact(service, version);
}

function assertFullVersions(
  versions: Partial<Record<ServiceName, string | undefined>>,
): asserts versions is Record<ServiceName, string> {
  const missing = SERVICE_NAMES.filter((service) => versions[service] === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing service versions for: ${missing.join(", ")}`);
  }
}

export function fullVersionManifest(
  versions: Partial<Record<ServiceName, string | undefined>>,
): VersionManifest {
  assertFullVersions(versions);
  return versions;
}

/**
 * Normalizes a version string for a service based on its image tag prefix.
 *
 * Services with a "v" prefix in IMAGE_TAG_PREFIX (e.g. postgrest, auth) store
 * versions without the "v" prefix (it gets prepended at image-pull time).
 * Services without a prefix entry but whose DEFAULT_VERSIONS start with "v"
 * (e.g. imgproxy, mailpit) store versions with the "v" prefix.
 * All other services pass through trimmed.
 */
export function normalizeServiceVersion(service: ServiceName, version: string): string {
  const trimmed = version.trim();
  const prefix = IMAGE_TAG_PREFIX[service];

  if (prefix === "v") {
    return trimmed.replace(/^v/i, "");
  }

  if (prefix === undefined && DEFAULT_VERSIONS[service].startsWith("v")) {
    return /^v/i.test(trimmed) ? `v${trimmed.slice(1)}` : `v${trimmed}`;
  }

  return trimmed;
}

export function normalizeServiceVersions(
  versions: Partial<Record<ServiceName, string | undefined>>,
): Partial<VersionManifest> {
  const normalized: Partial<Record<ServiceName, string>> = {};
  for (const service of SERVICE_NAMES) {
    const version = versions[service];
    if (typeof version === "string" && version.trim().length > 0) {
      normalized[service] = normalizeServiceVersion(service, version);
    }
  }
  return normalized;
}

export function fillServiceVersionManifest(
  versions: Partial<Record<ServiceName, string | undefined>>,
): VersionManifest {
  const filled: Partial<Record<ServiceName, string>> = {};
  for (const service of SERVICE_NAMES) {
    filled[service] = versions[service] ?? DEFAULT_VERSIONS[service];
  }
  return fullVersionManifest(filled);
}

export interface AvailableServiceVersionUpdate {
  readonly service: ServiceName;
  readonly pinnedVersion: string;
  readonly availableVersion: string;
}

export function diffPinnedAndAvailableVersions(
  pinnedBaseline: VersionManifest,
  candidateBaseline: VersionManifest,
): ReadonlyArray<AvailableServiceVersionUpdate> {
  return SERVICE_NAMES.flatMap((service) => {
    const pinnedVersion = pinnedBaseline[service];
    const availableVersion = candidateBaseline[service];
    if (pinnedVersion === availableVersion) {
      return [];
    }
    return [{ service, pinnedVersion, availableVersion }];
  });
}
import { Schema } from "effect";
